import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";

import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { createTestModel } from "./helpers/test-model";

describe("issue #816 — plan mode pendingModelSwitch leak", () => {
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
		authStorage.keys.setRuntime("test", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = createTestModel({ provider: "test", id: "test-model" });

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
