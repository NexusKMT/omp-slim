import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const model = (id: string) => getBundledModel("anthropic", id) as Model;

// Settings writes made through the model hub, driven through the controller's real hub callbacks.
describe("SelectorController model hub writes", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-selector-model-writes-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	function start(settings: Settings, initial: Model): { controller: SelectorController; showError: () => unknown } {
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		session = live;
		const showError = vi.fn();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: live,
				settings,
				ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showError,
			}),
		);
		return { controller, showError };
	}

	function openModelHub(controller: SelectorController): modelHubModule.ModelHubCallbacks {
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
		} as never);
		controller.showModelSelector();
		if (!callbacks) throw new Error("model hub was not opened");
		return callbacks;
	}

	it("persists the chosen current model and changes the live session", async () => {
		const agentDir = tempDir.join("agent");
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		await openModelHub(controller).onSelect(model("claude-opus-4-5"), undefined, "anthropic/claude-opus-4-5");
		await settings.flush();
		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved.model).toBe("anthropic/claude-opus-4-5");
		expect(Object.hasOwn(saved, "modelRoles")).toBe(false);
	});
	it("saves project model selections to project scope without promoting them to the global file", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(tempDir.join(".omp", "config.yml"), YAML.stringify({ modelStorage: "project" }));
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		await openModelHub(controller).onSelect(model("claude-opus-4-5"), undefined, "anthropic/claude-opus-4-5");
		await settings.flush();
		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
		const project = YAML.parse(await Bun.file(tempDir.join(".omp", "config.yml")).text()) as RawSettings;
		expect(project.model).toBe("anthropic/claude-opus-4-5");
		const global = Bun.file(path.join(agentDir, "config.yml"));
		expect(
			(await global.exists()) ? (YAML.parse(await global.text()) as RawSettings).model : undefined,
		).toBeUndefined();
	});

	it("refreshes the open hub once a confirmed compaction point has moved the model to its extended window", async () => {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const registry = session!.modelRegistry;
		const terra = registry.find("openai", "gpt-5.6-terra");
		if (!terra) throw new Error("Expected bundled gpt-5.6-terra");
		const refreshed = Promise.withResolvers<number | null | undefined>();
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			const callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			queueMicrotask(() => {
				expect(callbacks.onCompactionPointChange?.(terra, "400k", true)).toBeUndefined();
			});
			return {
				// The window the hub would re-read when it refreshes.
				refreshAfterExternalMutation: () =>
					refreshed.resolve(registry.find("openai", "gpt-5.6-terra")?.contextWindow),
				dispose: () => {},
			};
		} as never);
		controller.showModelSelector();

		expect(await refreshed.promise).toBe(1_050_000);
		expect(showError).not.toHaveBeenCalled();
	});
});
