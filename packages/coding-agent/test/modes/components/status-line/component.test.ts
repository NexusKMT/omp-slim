import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "../../../../src/session/agent-session";
import { StatusLineTestComponents } from "../../../helpers/status-line";

const statusLines = new StatusLineTestComponents();

function makeSessionWithLastMessage(
	lastMessage: unknown,
	{
		cost = 0,
		modelName,
		sessionName = "test-session",
	}: {
		cost?: number;
		modelName?: string;
		sessionName?: string;
	} = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { name: modelName, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { name: modelName, contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => sessionName,
		},
		getAsyncJobSnapshot: () => undefined,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterAll(() => {
	statusLines.dispose();
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage({
					role: "assistant",
					timestamp: 1,
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { offset: 1n, nested: { limit: 2n } },
						},
					],
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("shows the context window without a percent while usage is unknown", () => {
		const session = makeSessionWithLastMessage(null);
		const known = statusLines.track(new StatusLineComponent(session as unknown as AgentSession, statusLineHost));
		const unknown = statusLines.track(
			new StatusLineComponent(
				{
					...session,
					getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: null }),
				} as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(Bun.stripANSI(known.getTopBorder(120).content)).toMatch(/\d%/);
		const border = Bun.stripANSI(unknown.getTopBorder(120).content);
		expect(border).toContain("128K");
		expect(border).not.toContain("%");
	});
});
