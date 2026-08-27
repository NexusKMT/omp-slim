/**
 * Coverage for the per-turn prompt→yield time (Δ + clock) in transcript usage
 * rows, gated by `display.showTurnTime` — the delta sits right after the turn's
 * timestamp and counts hooks, tool calls, and the final generation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { formatUsageRow } from "@oh-my-pi/pi-coding-agent/modes/components/usage-row";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container, type TUI } from "@oh-my-pi/pi-tui";

// 60s of elapsed: 30s between the prompt and the final response's creation,
// plus a 30s provider request — formatDuration renders this as "1m".
const PROMPT_AT = new Date(2026, 0, 2, 3, 4, 5).getTime();
const RESPONSE_CREATED_AT = PROMPT_AT + 30_000;
const REQUEST_DURATION_MS = 30_000;
const USAGE_LABEL = "4.2K";
const TURN_ELAPSED_LABEL = "Δ1m";

type AssistantFixture = Extract<AgentMessage, { role: "assistant" }>;

function assistantMessage(overrides: Partial<AssistantFixture> = {}): AssistantFixture {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 4242,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4249,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: RESPONSE_CREATED_AT,
		duration: REQUEST_DURATION_MS,
		...overrides,
	} as unknown as AssistantFixture;
}

function userMessage(text = "build it"): AgentMessage {
	return { role: "user", content: text, timestamp: PROMPT_AT } as unknown as AgentMessage;
}

function toEntries(
	messages: AgentMessage[],
): Array<{ type: "message"; id: string; parentId: string | null; timestamp: string; message: AgentMessage }> {
	return messages.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: new Date(0).toISOString(),
		message,
	}));
}

function renderedText(container: Container): string {
	return Bun.stripANSI(container.children.map(child => child.render(120).join("\n")).join("\n"));
}

describe("formatUsageRow turn elapsed", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the clock-and-delta prompt→yield time right after the timestamp", () => {
		const row = formatUsageRow(assistantMessage().usage as Usage, REQUEST_DURATION_MS, undefined, PROMPT_AT, 60_000);
		expect(row.indexOf("2026-01-02 03:04:05")).toBeLessThan(row.indexOf(TURN_ELAPSED_LABEL));
		expect(row).toContain(TURN_ELAPSED_LABEL);
	});

	it("omits the delta when no elapsed is supplied", () => {
		expect(formatUsageRow(assistantMessage().usage as Usage)).not.toContain("Δ");
	});
});

describe("ChatTranscriptBuilder turn elapsed", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function builder(): ChatTranscriptBuilder {
		return new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
	}

	it("shows the prompt→yield delta when display.showTurnTime is on", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage()]));
		const rendered = renderedText(transcript.container);
		expect(rendered).toContain(TURN_ELAPSED_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("hides the delta when display.showTurnTime is off", () => {
		settings.set("display.showTurnTime", false);
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage()]));
		expect(renderedText(transcript.container)).not.toContain(TURN_ELAPSED_LABEL);
	});

	it("shows no delta when the turn start is unknown (no user message)", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		transcript.rebuild(toEntries([assistantMessage()]));
		expect(renderedText(transcript.container)).not.toContain(TURN_ELAPSED_LABEL);
	});
});

describe("UiHelpers.renderSessionContext turn elapsed", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function makeHarness(turnTimeOn: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
		let helpers: UiHelpers;
		const ctx = {
			chatContainer: new Container(),
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			settings: {
				get: (key: string) =>
					key === "display.showTokenUsage" ? true : key === "display.showTurnTime" ? turnTimeOn : false,
			},
			getUserMessageText: (message: { content?: unknown }) =>
				typeof message.content === "string" ? message.content : "",
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			session: {
				retryAttempt: 0,
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => process.cwd(), putBlobSync: () => undefined },
			},
			get viewSession() {
				return (this as typeof ctx).session;
			},
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			clearTransientSessionUi: () => {},
		} as unknown as InteractiveModeContext;
		helpers = new UiHelpers(ctx);
		return { ctx, helpers };
	}

	it("renders the delta on the rebuilt usage row after the turn timestamp", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: [userMessage(), assistantMessage()] } as SessionContext);
		const rendered = renderedText(ctx.chatContainer);
		expect(rendered).toContain(TURN_ELAPSED_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("omits the delta when display.showTurnTime is off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: [userMessage(), assistantMessage()] } as SessionContext);
		expect(renderedText(ctx.chatContainer)).not.toContain(TURN_ELAPSED_LABEL);
	});
});
