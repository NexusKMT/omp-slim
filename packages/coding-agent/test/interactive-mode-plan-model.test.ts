import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";

describe("plan mode uses the current model", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-816-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the current model and thinking while entering and pausing during a stream", async () => {
		const selectedModel = session.model;
		session.setThinkingLevel(ThinkingLevel.High);
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
		vi.spyOn(session, "abort").mockImplementation(async () => {
			streaming = false;
		});
		const setModel = vi.spyOn(session, "setModelTemporary");
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(session.model).toBe(selectedModel);
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(session.model).toBe(selectedModel);
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("preserves a manual model selection when pausing plan mode", async () => {
		await mode.handlePlanModeCommand();
		const selectedModel = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!selectedModel) throw new Error("Expected opus in the registry");
		await session.setModelTemporary(selectedModel, ThinkingLevel.High);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(session.model).toBe(selectedModel);
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
	});

	it("does not enter plan mode when plan.enabled is false", async () => {
		cfgPlanEnabled.set(session.settings, false);
		const warning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(warning).toHaveBeenCalledWith("Plan mode is disabled. Enable it in settings (plan.enabled).");
	});

	it("allows /plan to pause an active plan mode after plan.enabled is disabled", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		cfgPlanEnabled.set(session.settings, false);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(true);
	});
});
