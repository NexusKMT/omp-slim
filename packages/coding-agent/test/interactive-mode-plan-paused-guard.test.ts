/**
 * Contract: once plan mode is toggled off into the *paused* state, the guards
 * that block goal/vibe entry must say the plan session is paused (and how to
 * fully exit) rather than the stale "Exit plan mode first." — which reads as
 * self-contradictory right after the user just exited plan mode (#11692).
 *
 * While the plan session is still *active*, the guard keeps the original
 * "Exit plan mode first." wording.
 */
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createTestModel } from "./helpers/test-model";

describe("InteractiveMode paused-plan guard message", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-plan-paused-guard-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = createTestModel({ provider: "test", id: "test-model" });
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: () => {
					throw new Error("No test stream configured");
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});
	it("keeps 'Exit plan mode first.' while the plan session is still active", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		const warn = vi.spyOn(mode, "showWarning");

		await mode.handleGoalModeCommand("ship");

		// Active session: instruct exit, without the paused wording.
		const messages = warn.mock.calls.map(call => String(call[0]));
		expect(messages).toHaveLength(1);
		expect(messages[0].toLowerCase()).toContain("exit plan mode");
		expect(messages[0].toLowerCase()).not.toContain("paused");
	});
});
