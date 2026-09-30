import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	applyModelPreset,
	deleteModelPreset,
	getModelPresetNames,
	saveModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelPresets } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const SONNET = "anthropic/claude-sonnet-4-5";
const SONNET_46 = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-4-5";

function bundled(selector: string) {
	const [, id] = selector.split("/");
	const model = getBundledModel("anthropic", id!);
	if (!model) throw new Error(`missing bundled model ${selector}`);
	return model;
}

describe("model presets", () => {
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-model-presets-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function createSession(settings: Settings, initialModel = SONNET, thinkingLevel: Effort = Effort.High) {
		const agent = new Agent({
			initialState: { model: bundled(initialModel), systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel },
		});
		const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	/** Settings with a real project layer and an optional `--config` overlay. */
	async function projectSettings(options: { project?: string; overlay?: string; storage?: "global" | "project" }) {
		const dir = TempDir.createSync("@pi-model-presets-project-");
		tempDirs.push(dir);
		const projectDir = path.join(dir.path(), "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		if (options.project) fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), options.project);
		const configFiles: string[] = [];
		if (options.overlay) {
			const overlayPath = path.join(dir.path(), "overlay.yml");
			fs.writeFileSync(overlayPath, options.overlay);
			configFiles.push(overlayPath);
		}
		return Settings.loadIsolated({
			cwd: projectDir,
			agentDir: dir.path(),
			inMemory: true,
			configFiles,
			overrides: options.storage ? { modelRoleStorage: options.storage } : {},
		});
	}

	it("switching replaces the whole role record and applies the preset's thinking level live", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", OPUS);
		settings.setModelRole("plan", SONNET_46);
		cfgDefaultThinkingLevel.set(settings, Effort.Low);
		saveModelPreset(settings, "focus");

		settings.setModelRole("default", SONNET);
		settings.setModelRole("plan", undefined);
		settings.setModelRole("smol", SONNET_46);
		cfgDefaultThinkingLevel.set(settings, Effort.High);
		const session = createSession(settings, SONNET, Effort.High);

		const result = await applyModelPreset(settings, session, "focus");

		expect(result.kind).toBe("switched");
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS, plan: SONNET_46 });
		expect(session.model?.id).toBe("claude-opus-4-5");
		// setModel alone keeps the previous `high`; the preset's `low` must win.
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(cfgDefaultThinkingLevel.get(settings)).toBe(Effort.Low);
	});

	it("an explicit selector level on the preset's default beats its defaultThinkingLevel", async () => {
		const settings = Settings.isolated();
		cfgModelPresets.setEntry(settings, "deep", {
			modelRoles: { default: `${OPUS}:medium` },
			defaultThinkingLevel: Effort.Low,
		});
		const session = createSession(settings, SONNET, Effort.High);

		const result = await applyModelPreset(settings, session, "deep");

		expect(result.kind).toBe("switched");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("in project storage, replaces project-scoped roles instead of leaving stale ones", async () => {
		const settings = await projectSettings({
			project: `modelRoles:\n  default: ${SONNET}\n  slow: ${SONNET_46}\n`,
			storage: "project",
		});
		cfgModelPresets.setEntry(settings, "lean", { modelRoles: { default: OPUS } });
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "lean");

		expect(result).toMatchObject({ kind: "switched", shadowed: [] });
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS });
		expect(settings.getProjectModelRole("slow")).toBeUndefined();
		expect(session.model?.id).toBe("claude-opus-4-5");
	});

	it("replaces --model style runtime role overrides like a model hub edit", async () => {
		const settings = Settings.isolated();
		settings.overrideModelRoles({ default: SONNET, smol: SONNET_46 });
		cfgModelPresets.setEntry(settings, "opus", { modelRoles: { default: OPUS } });
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "opus");

		expect(result).toMatchObject({ kind: "switched", shadowed: [] });
		expect({ ...settings.getModelRoles() }).toEqual({ default: OPUS });
	});

	it("reports roles a higher layer still decides instead of claiming a clean switch", async () => {
		const settings = await projectSettings({
			project: `modelRoles:\n  slow: ${SONNET_46}\n`,
			overlay: `modelRoles:\n  default: ${SONNET}\n`,
		});
		cfgModelPresets.setEntry(settings, "opus", { modelRoles: { default: OPUS } });
		const session = createSession(settings, SONNET);

		const result = await applyModelPreset(settings, session, "opus");

		if (result.kind !== "switched") throw new Error(`expected switched, got ${result.kind}`);
		expect(result.shadowed).toEqual([
			{ role: "default", expected: OPUS, actual: SONNET, source: "overlay" },
			{ role: "slow", expected: undefined, actual: SONNET_46, source: "project" },
		]);
		// The live model follows the effective default, which the overlay still decides.
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(settings.getGlobalModelRole("default")).toBe(OPUS);
	});

	it("never resolves inherited object keys as presets", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		const session = createSession(settings);

		for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
			expect((await applyModelPreset(settings, session, name)).kind).toBe("missing");
			expect(deleteModelPreset(settings, name)).toBe("missing");
		}
		expect(settings.getModelRole("default")).toBe(SONNET);
	});

	it("rejects a malformed hand-written preset without touching roles", async () => {
		const settings = await projectSettings({
			overlay: `modelPresets:\n  broken:\n    modelRoles: ${OPUS}\n`,
		});
		settings.setModelRole("default", SONNET);
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "broken");

		expect(result.kind).toBe("invalid");
		expect(settings.getModelRole("default")).toBe(SONNET);
	});

	it("leaves settings untouched when the preset's default model is unavailable", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		cfgModelPresets.setEntry(settings, "gone", { modelRoles: { default: "nosuch/provider-model" } });
		const session = createSession(settings);

		const result = await applyModelPreset(settings, session, "gone");

		expect(result.kind).toBe("unavailable");
		expect(settings.getModelRole("default")).toBe(SONNET);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	it("reports a failed live switch instead of success", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", SONNET);
		cfgModelPresets.setEntry(settings, "opus", { modelRoles: { default: OPUS } });
		const session = createSession(settings);
		vi.spyOn(session, "setModel").mockRejectedValue(new Error("metadata refresh failed"));

		const result = await applyModelPreset(settings, session, "opus");

		expect(result).toMatchObject({ kind: "failed", reason: "metadata refresh failed" });
	});

	it("saves only the named entry globally and never copies project presets", async () => {
		const settings = await projectSettings({
			project: `modelPresets:\n  team:\n    modelRoles:\n      default: ${SONNET}\n`,
		});
		settings.setModelRole("default", OPUS);

		saveModelPreset(settings, "mine");

		expect(Object.keys(settings.getGlobalSettings().modelPresets ?? {})).toEqual(["mine"]);
		expect(getModelPresetNames(settings)).toEqual(["mine", "team"]);
		expect(deleteModelPreset(settings, "team")).toBe("project");
		expect(deleteModelPreset(settings, "mine")).toBe("deleted");
		expect(getModelPresetNames(settings)).toEqual(["team"]);
	});
});
