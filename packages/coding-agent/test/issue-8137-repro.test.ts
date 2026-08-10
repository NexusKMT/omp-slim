import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Issue #8137 — a `/skill:<name>` token embedded in a `/plan [prompt]` (or
 * `/vibe [prompt]`) inline prompt was delivered to the agent as literal text
 * instead of loading the skill.
 *
 * Contract: entering plan/vibe mode with an inline prompt whose text invokes a
 * registered skill dispatches the skill as a user-attributed
 * SKILL_PROMPT_MESSAGE (surrounding prose collapsed into the skill args),
 * rather than submitting the raw `.../skill:<name>` text as a normal prompt.
 */
describe("issue #8137 — inline /skill in mode-command prompts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-8137-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
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

		const skillPath = path.join(tempDir.path(), "grilling.md");
		await Bun.write(skillPath, "---\nname: grilling\n---\nGrill the steak thoroughly.\n");
		const skill: Skill = {
			name: "grilling",
			description: "Grilling skill",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		};
		mode.skillCommands.set("skill:grilling", skill);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.resetInstance();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("dispatches an inline /skill invocation from a /plan prompt as a skill message", async () => {
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		let submitted: { text: string } | undefined;
		mode.onInputCallback = input => {
			submitted = input;
		};

		await mode.handlePlanModeCommand("do X /skill:grilling");

		expect(mode.planModeEnabled).toBe(true);
		// The skill goes through the custom-message path, NOT a raw prompt.
		expect(submitted).toBeUndefined();
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const [message] = promptCustomMessage.mock.calls[0] ?? [];
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.details).toMatchObject({ name: "grilling", args: "do X" });
	});

	it("still submits a non-skill /plan prompt as a normal prompt", async () => {
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		let submitted: { text: string } | undefined;
		mode.onInputCallback = input => {
			submitted = input;
		};

		await mode.handlePlanModeCommand("just plan the migration");

		expect(mode.planModeEnabled).toBe(true);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(submitted?.text).toBe("just plan the migration");
	});
});
