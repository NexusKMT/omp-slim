import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getTestModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, clampAutoThinkingEffort, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";

/**
 * Per-model thinking ladders the uniform synthetic fixture default loses. These
 * ids pin production-model capabilities the tests assert against; the fixture
 * default (`[low, medium, high]`) is only correct for claude-sonnet-4-6.
 */
const TEST_MODEL_OVERRIDES: Record<string, Partial<Model>> = {
	"anthropic/claude-sonnet-4-5": {
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultLevel: Effort.Medium,
		},
	},
	"anthropic/claude-opus-4-7": {
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultLevel: Effort.Medium,
		},
	},
	"openai/gpt-4o-mini": {
		reasoning: false,
		thinking: undefined,
	},
};

const bundledModelCache = new Map<string, Model>();

/** Bundled-catalog lookup: stable references plus the per-model thinking ladder. */
function getBundledModel(provider: string, id: string): Model | undefined {
	const key = `${provider}/${id}`;
	const cached = bundledModelCache.get(key);
	if (cached) return cached;
	const model = getTestModel(provider, id, TEST_MODEL_OVERRIDES[key] ?? {});
	bundledModelCache.set(key, model);
	return model;
}

const MODELS_CONFIG = [
	"providers:",
	"  anthropic:",
	"    baseUrl: https://models.example.invalid/v1",
	"    api: openai-completions",
	"    models:",
	"      - id: claude-sonnet-4-5",
	"        thinking:",
	"          mode: effort",
	"          efforts: [minimal, low, medium, high, xhigh]",
	"          defaultLevel: medium",
	"      - id: claude-sonnet-4-6",
	"        thinking:",
	"          mode: effort",
	"          efforts: [minimal, low, medium, high]",
	"          defaultLevel: medium",
	"      - id: claude-opus-4-7",
	"        thinking:",
	"          mode: effort",
	"          efforts: [minimal, low, medium, high, xhigh, max]",
	"          defaultLevel: medium",
	"  openai:",
	"    baseUrl: https://models.example.invalid/v1",
	"    api: openai-completions",
	"    models:",
	"      - id: gpt-4o-mini",
	"        reasoning: false",
	"  google-antigravity:",
	"    baseUrl: https://models.example.invalid/v1",
	"    api: openai-completions",
	"    models:",
	"      - id: gemini-3.8-flash",
	"        thinking:",
	"          mode: effort",
	"          efforts: [minimal, low, medium, high]",
	"          defaultLevel: medium",
].join("\n");

describe("AgentSession single model thinking behavior", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-role-thinking-fixture-");
		writeFileSync(path.join(fixtureDir.path(), "models.yml"), MODELS_CONFIG);
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		model?: string;
		runtimeApiKeys?: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");
		const runtimeApiKeys = options.runtimeApiKeys ?? {};
		for (const provider in runtimeApiKeys) {
			authStorage.keys.setRuntime(provider, runtimeApiKeys[provider]);
		}

		sessionSettings = Settings.isolated();
		sessionSettings.setModel(options.model);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("rejects retired role assignments without changing the active model", async () => {
		const current = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const other = getAnthropicModelOrThrow("claude-sonnet-4-6");
		await createSession({
			initialModelId: current.id,
			initialThinkingLevel: Effort.High,
			model: `${current.provider}/${current.id}`,
		});
		await expect(session.setModel(other, "plan", { persist: true })).rejects.toThrow("has been removed");
		expect(session.model).toBe(current);
		expect(sessionSettings.getModel()).toBe(`${current.provider}/${current.id}`);
	});

	it("preserves an explicit auto suffix when saving the primary model", async () => {
		const current = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const selected = getAnthropicModelOrThrow("claude-sonnet-4-6");
		await createSession({ initialModelId: current.id, initialThinkingLevel: Effort.High });
		await session.setModel(selected, "default", { persist: true, thinkingLevel: AUTO_THINKING });
		expect(sessionSettings.getModel()).toBe(`${selected.provider}/${selected.id}:auto`);
	});

	it("preserves explicit thinking when updating the primary model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			model: "anthropic/nonexistent-model:off",
		});

		await session.setModel(slowModel, "default", { persist: true });

		expect(sessionSettings.getModel()).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it.each([
		{ selector: "a:max", id: "a:max", available: true },
		{ selector: "a:max", id: "a:max", available: false },
		{ selector: "A:max", id: "a:max", available: true },
		{ selector: "A:auto", id: "a:auto", available: false },
	])("does not inherit literal effort from $selector (available=$available)", async ({ selector, id, available }) => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const literalModel = { ...defaultModel, id };

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			model: selector,
		});
		const allModels = modelRegistry.getAll("all");
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([...allModels, literalModel]);
		if (available) {
			const availableModels = modelRegistry.getAvailable();
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([...availableModels, literalModel]);
		}

		await session.setModel(nextModel, "default", { persist: true });

		expect(sessionSettings.getModel()).toBe(`${nextModel.provider}/${nextModel.id}`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("clamps max selections down to the ladder ceiling on models without a max tier", async () => {
		// Budget-mode sonnet-4-5 tops out at xhigh; a max request must clamp down.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getAvailableThinkingLevels()).not.toContain("max");
	});

	it("cycles through off and auto before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(agent.state.disableReasoning).toBe(true);
		expect(session.cycleThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(agent.state.disableReasoning).toBe(false);
		const autoReceipt = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change")
			.at(-1);
		expect(autoReceipt).toMatchObject({
			thinkingLevel: resolveProvisionalAutoLevel(model),
			configured: AUTO_THINKING,
		});
		const autoReceiptCount = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change").length;
		session.setThinkingLevel(AUTO_THINKING);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			autoReceiptCount,
		);
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("cycles through max as the final tier on a max-capable model", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		const available = session.getAvailableThinkingLevels();
		expect(available.at(-1)).toBe(Effort.Max);

		session.setThinkingLevel(Effort.XHigh);
		expect(session.cycleThinkingLevel()).toBe(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.Max);
		// max is the last tier: the wheel wraps back to off.
		expect(session.cycleThinkingLevel()).toBe("off");
	});

	it("keeps auto configured while applying the local default effort as the effective level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		await session.prompt("Implement a focused parser fix");

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(session.autoResolvedThinkingLevel()).toBe(resolveProvisionalAutoLevel(model));
		expect(session.agent.state.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
	});

	it("resolves a user-invoked /skill turn under auto (resolves concrete effort)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		// A /skill:<name> invocation reaches the session as a user-attributed
		// custom message, not a `user` role. It is still a real user turn.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Expanded SKILL.md body: implement the focused parser fix",
			display: true,
			details: { name: "implement", path: "/skills/implement/SKILL.md", args: "the parser" },
			attribution: "user",
		});

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(session.autoResolvedThinkingLevel()).toBe(resolveProvisionalAutoLevel(model));
		expect(session.agent.state.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
	});

	it("does not resolve effort for an agent-originated skill custom message under auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);

		// Autoloaded / agent-originated skill injections must stay excluded.
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Autoloaded skill body",
			display: false,
			details: { name: "autoload", path: "/skills/autoload/SKILL.md" },
			attribution: "agent",
		});

		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps auto active on resume (pending until the next turn resolves effort)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		cfgDefaultThinkingLevel.set(sessionSettings, AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("Implement a focused parser fix");

		expect(session.isAutoThinking).toBe(true);
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		// Resumes in auto and pending — not frozen to the last resolved level, and
		// not pre-seeded; the next user turn reclassifies.
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps a manual concrete pin (not auto) on resume even when the global default is auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		cfgDefaultThinkingLevel.set(sessionSettings, AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// User pins a concrete level mid-session; it must survive resume as-is and
		// must not be reinterpreted as `auto` just because the global default is auto.
		session.setThinkingLevel(Effort.Low);
		expect(session.isAutoThinking).toBe(false);
		await session.prompt("Pinned concrete turn");
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("persists a concrete pin that matches the auto-resolved effort so resume stays concrete", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		authStorage.keys.setRuntime("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		cfgDefaultThinkingLevel.set(sessionSettings, AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// Auto resolves to medium.
		await session.prompt("Implement a focused parser fix");
		expect(session.autoResolvedThinkingLevel()).toBe(resolveProvisionalAutoLevel(model)!);

		// User then pins the *same* effort: selector changes auto -> medium even though
		// the effort is unchanged, so it must persist as a concrete pin (entry +
		// defaultThinkingLevel), not silently stay `configured: "auto"`.
		session.setThinkingLevel(resolveProvisionalAutoLevel(model)!, true);
		expect(session.isAutoThinking).toBe(false);
		expect(cfgDefaultThinkingLevel.get(sessionSettings)).toBe(resolveProvisionalAutoLevel(model)!);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(resolveProvisionalAutoLevel(model)!);
	});

	it("falls back to a concrete auto level when using legacy auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		const fallback = resolveProvisionalAutoLevel(model);
		await session.prompt("Investigate a regression");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(fallback);
		expect(session.autoResolvedThinkingLevel()).toBe(fallback);
		expect(session.agent.state.thinkingLevel).toBe(fallback);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
			1,
		);
	});

	it("skips local auto effort for synthetic turns", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		const provisional = resolveProvisionalAutoLevel(model);
		await session.prompt("Synthetic maintenance turn", { synthetic: true });

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("maps ultrathink prompts to the model's highest supported level, clamped below max", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		// sonnet-4-5 has no max tier, so the ultrathink jump clamps to xhigh.
		const expected = clampAutoThinkingEffort(model, Effort.Max);
		expect(expected).toBe(Effort.XHigh);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(session.thinkingLevel).toBe(expected);
		expect(session.autoResolvedThinkingLevel()).toBe(expected);
	});

	it("resolves ultrathink to max on max-capable models", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(session.thinkingLevel).toBe(Effort.Max);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Max);
	});

	it("keeps auto effectively off for non-reasoning models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		authStorage.keys.setRuntime("openai", "test-key");
		sessionSettings = Settings.isolated();
		cfgDefaultThinkingLevel.set(sessionSettings, AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		expect(session.isAutoThinking).toBe(true);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();

		await session.prompt("Implement a tiny change");

		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("applies primary selector thinking to temporary model picks", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getBundledModel("google-antigravity", "gemini-3.8-flash");
		if (!temporaryModel) throw new Error("Expected google-antigravity model gemini-3.8-flash to exist");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			model: `${temporaryModel.provider}/${temporaryModel.id}:high`,
			runtimeApiKeys: {
				[temporaryModel.provider]: "test-key",
			},
		});

		const roleResolved = session.resolveRoleModelWithThinking("smol");
		expect(roleResolved.model?.id).toBe(defaultModel.id);
		expect(roleResolved.thinkingLevel).toBeUndefined();

		const roleThinkingLevel = session.resolveTemporaryModelThinkingLevel(temporaryModel);
		await session.setModelTemporary(temporaryModel, roleThinkingLevel);

		expect(session.model?.provider).toBe(temporaryModel.provider);
		expect(session.model?.id).toBe(temporaryModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("does not carry the previous session's auto-resolved level across /new (#13383)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			model: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("Classify this turn");
		// The first session resolved its model default; the cache is what `/new` must drop.
		expect(session.isAutoThinking).toBe(true);
		expect(session.autoResolvedThinkingLevel()).toBe(resolveProvisionalAutoLevel(model));

		await session.newSession();

		// The configured auto mode survives, but the per-turn cache is gone,
		// so the next turn resolves effort its own prompt from undefined.
		expect(session.isAutoThinking).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
		const provisional = resolveProvisionalAutoLevel(model);
		const entries = session.sessionManager.getEntries().filter(e => e.type === "thinking_level_change");
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.agent.state.thinkingLevel).toBe(provisional);
		expect(entries.at(-1)).toMatchObject({ thinkingLevel: provisional, configured: AUTO_THINKING });
	});
});
