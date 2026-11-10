import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Advisors inherit the primary's effort and follow changes at review boundaries.
describe("advisor auto thinking level", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	function newSession(
		streamFn?: Agent["streamFn"],
		settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
		advisorStreamFn?: Agent["streamFn"],
	): AgentSession {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			...(streamFn ? { streamFn } : {}),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
		});
		return session;
	}

	it("follows the primary session's auto level instead of the medium fallback", () => {
		const s = newSession();
		s.setThinkingLevel(AUTO_THINKING);
		expect(s.isAutoThinking).toBe(true);
		const primaryLevel = s.thinkingLevel;
		// The provisional auto level is deliberately above the advisor's medium
		// fallback, so a passing assertion cannot be the old behavior.
		expect(primaryLevel).not.toBe(Effort.Medium);

		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(toReasoningEffort(primaryLevel));
	});

	it("turns advisor reasoning off at the next review boundary when the primary turns it off", async () => {
		const mock = createMockModel({ handler: { content: ["primary complete"] } });
		const s = newSession(mock.stream);
		s.setThinkingLevel(Effort.High);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(Effort.High);

		s.setThinkingLevel(ThinkingLevel.Off);
		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);
		expect(s.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBeUndefined();
		expect(advisor.state.disableReasoning).toBe(true);

		// The live retune and a fresh build agree on the level.
		s.setAdvisorEnabled(false);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		expect(s.getAdvisorAgent()?.state.thinkingLevel).toBeUndefined();
		expect(s.getAdvisorAgent()?.state.disableReasoning).toBe(true);
	});

	it("retunes the live advisor at the turn boundary without rebuilding or resetting it", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const s = newSession(mock.stream);
		// Build the advisor while the primary is pinned low: a later move off low
		// can only come from the turn-boundary retune.
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);

		// Switching the primary to auto must not, by itself, move the advisor:
		// only a review boundary retunes it.
		s.setThinkingLevel(AUTO_THINKING);
		const primaryAuto = toReasoningEffort(s.thinkingLevel);
		expect(primaryAuto).not.toBe(Effort.Low);
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);

		// The retune must move the effort only: switching models or invalidating
		// the append-only prefix would throw away the advisor's cached context.
		const setModel = vi.spyOn(advisorBefore, "setModel");
		const invalidate = advisorBefore.appendOnlyContext
			? vi.spyOn(advisorBefore.appendOnlyContext, "invalidateForModelChange")
			: undefined;
		const messagesBefore = advisorBefore.state.messages.length;

		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);

		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(advisorBefore.state.thinkingLevel).toBe(primaryAuto);
		expect(setModel).not.toHaveBeenCalled();
		expect(invalidate?.mock.calls.length ?? 0).toBe(0);
		expect(advisorBefore.state.messages.length).toBeGreaterThanOrEqual(messagesBefore);
		// `/dump advisor` is the one UI surface that shows the advisor's own
		// effort (the status-line tail is the primary's level), so the retune
		// must be visible there too.
		expect(s.formatAdvisorHistoryAsText()).toContain(`Thinking Level: ${primaryAuto}`);
	});

	it("follows the primary off auto onto a pinned level at the next review boundary", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const s = newSession(mock.stream);
		s.setThinkingLevel(AUTO_THINKING);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		const primaryAuto = toReasoningEffort(s.thinkingLevel);
		expect(advisorBefore.state.thinkingLevel).toBe(primaryAuto);
		// The pinned level must differ from the one the advisor inherited, so a
		// passing assertion cannot be the advisor staying where it was.
		expect(primaryAuto).not.toBe(Effort.Low);

		s.setThinkingLevel(Effort.Low);
		expect(s.isAutoThinking).toBe(false);
		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);

		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);
	});
});
