import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #6879 — a tool call renders twice (follow-up to #6516).
 *
 * Failed/aborted assistant attempts used to leave never-run cards above a
 * retry's fresh copies. Separately, when a successful read's persisted result
 * won a transcript-rebuild race, replay rendered the completed card before the
 * live `tool_execution_end`; its no-pending fallback then added another read
 * group. Both paths rendered one logical call more than once.
 */
const CMD = "which psql";
const READ_PATH = "src/index.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function bashToolCall(id: string): ToolCall {
	return { type: "toolCall", id, name: "bash", arguments: { command: CMD } };
}

function assistantMessage(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		timestamp: 2,
	} as unknown as AssistantMessage;
}

function countCommand(mode: InteractiveMode): number {
	const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
	let count = 0;
	let index = 0;
	while (true) {
		const found = rendered.indexOf(`$ ${CMD}`, index);
		if (found === -1) return count;
		count++;
		index = found + CMD.length;
	}
}

describe("issue #6879 — tool output appears twice after a superseded turn", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6879-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function streamToolCall(id: string, stopReason: string): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall(id)], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: bashToolCall(id),
				partial: assistantMessage([bashToolCall(id)], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([bashToolCall(id)], stopReason),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
	}

	async function streamReadToolCall(id: string, stopReason: string): Promise<void> {
		const readCall: ToolCall = {
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: READ_PATH, i: "Inspect entrypoint" },
		};
		const ec = mode.eventController;
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([readCall], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: readCall,
				partial: assistantMessage([readCall], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([readCall], stopReason),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
	}

	async function runToolCallToCompletion(id: string): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "bash",
			args: { command: CMD },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: "(no output)" }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await ec.handleEvent({ type: "message_end", message: assistantMessage([bashToolCall(id)], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
	}

	it("retracts a superseded turn's never-run tool card so an auto-retry renders it once", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		// Attempt 1: the tool call streams a card, then the turn errors out.
		await streamToolCall("call-attempt-1", "error");
		// agent-loop now pairs the failed assistant toolCall with a synthetic
		// start/end event sequence. It must be absorbed rather than recreating
		// the card that message_end just retracted.
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-attempt-1",
			toolName: "bash",
			args: { command: CMD },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-attempt-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "Tool call was not executed because the provider stream ended" }],
				details: { __synthetic: true, source: "assistant_stop_error", executed: false },
			},
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		// The failed card is retracted immediately (never committed to scrollback),
		// not left frozen on screen.
		expect(countCommand(mode)).toBe(0);

		await ec.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 0,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await ec.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 } as Extract<
			AgentSessionEvent,
			{ type: "auto_retry_end" }
		>);

		// Attempt 2 (retry) regenerates the call with a fresh id and runs it.
		await streamToolCall("call-attempt-2", "toolUse");
		await runToolCallToCompletion("call-attempt-2");

		expect(countCommand(mode)).toBe(1);
	});

	it("stops an animated tool card before retracting it", async () => {
		vi.useFakeTimers();
		try {
			const ec = mode.eventController;
			const requestComponentRender = vi.spyOn(mode.ui, "requestComponentRender");
			const writeCall: ToolCall = {
				type: "toolCall",
				id: "write-rewound",
				name: "write",
				arguments: { path: "out.txt", content: "pending content", i: "Write output" },
			};
			await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
			await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
				AgentSessionEvent,
				{ type: "message_start" }
			>);
			await ec.handleEvent({
				type: "message_update",
				message: assistantMessage([writeCall], "toolUse"),
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: writeCall,
					partial: assistantMessage([writeCall], "toolUse"),
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			const writeComponent = mode.pendingTools.get(writeCall.id);
			if (!writeComponent) throw new Error("Expected animated write component");

			vi.advanceTimersByTime(500);
			expect(requestComponentRender.mock.calls.some(call => call[0] === writeComponent)).toBeTrue();
			requestComponentRender.mockClear();

			await ec.handleEvent({
				type: "message_end",
				message: assistantMessage([writeCall], "aborted"),
			} as Extract<AgentSessionEvent, { type: "message_end" }>);
			expect(mode.pendingTools.has(writeCall.id)).toBeFalse();

			vi.advanceTimersByTime(1_000);
			expect(requestComponentRender.mock.calls.some(call => call[0] === writeComponent)).toBeFalse();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets a detached read group so the retry's grouped read stays visible", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		await streamReadToolCall("read-rewound", "aborted");
		expect(mode.pendingTools.has("read-rewound")).toBeFalse();

		await streamReadToolCall("read-rerun", "toolUse");
		const retryGroup = mode.pendingTools.get("read-rerun");
		if (!retryGroup) throw new Error("Expected retry read group");
		expect(mode.chatContainer.children).toContain(retryGroup);

		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: "read-rerun",
			toolName: "read",
			args: { path: READ_PATH, i: "Inspect entrypoint" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: "read-rerun",
			toolName: "read",
			result: { content: [{ type: "text", text: "entrypoint contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered).toContain(READ_PATH);
	});

	it("keeps a successful internal read single when replay beats its live completion", async () => {
		const ec = mode.eventController;
		const memoryPath = "memory://root/rollout_summaries/successful-read";
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-success",
			name: "read",
			arguments: { path: memoryPath, i: "Read successful memory" },
		};
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([readCall], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: readCall,
				partial: assistantMessage([readCall], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([readCall], "toolUse"),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: readCall.id,
			toolName: readCall.name,
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-success",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "read memory" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant-success",
				parentId: "user-success",
				timestamp: Date.now(),
				message: assistantMessage([readCall], "toolUse"),
			},
			{
				type: "message",
				id: "result-success",
				parentId: "assistant-success",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: readCall.id,
					toolName: readCall.name,
					content: [{ type: "text", text: "successful memory contents" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);
		mode.rebuildChatFromMessages();

		const replayCards = mode.chatContainer.children.filter(child =>
			Bun.stripANSI(child.render(120).join("\n")).includes(memoryPath),
		);
		expect(replayCards).toHaveLength(1);
		const replayChildCount = mode.chatContainer.children.length;

		// Persistence/replay won the race; the delayed live completion must not
		// create a fallback read group beside the completed replay card.
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: readCall.name,
			result: { content: [{ type: "text", text: "successful memory contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const matchingCards = mode.chatContainer.children.filter(child =>
			Bun.stripANSI(child.render(120).join("\n")).includes(memoryPath),
		);
		expect(matchingCards).toHaveLength(1);
		expect(mode.chatContainer.children).toHaveLength(replayChildCount);
	});

	it("retracts a TTSR-rewound turn's tool card so the re-run renders it once", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		// Attempt 1: card streams, turn is aborted (rewind) before executing.
		await streamToolCall("call-rewound", "aborted");
		expect(countCommand(mode)).toBe(0);

		// Fresh turn re-issues and completes the call.
		await streamToolCall("call-rerun", "toolUse");
		await runToolCallToCompletion("call-rerun");

		expect(countCommand(mode)).toBe(1);
	});

	it("re-keys a streamed tool card when its id is populated after the block appears", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		// Provider (e.g. GitHub Copilot) streams the tool block before its id: the
		// first delta carries an empty id, a later delta populates it.
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall("")], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage([bashToolCall("")], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(countCommand(mode)).toBe(1);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall("call-real")], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: assistantMessage([bashToolCall("call-real")], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		// The populated id must reuse the existing card, not spawn a second one.
		expect(countCommand(mode)).toBe(1);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([bashToolCall("call-real")], "toolUse"),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await runToolCallToCompletion("call-real");
		expect(countCommand(mode)).toBe(1);
		// The result routes into the surviving card (no orphaned pending preview).
		expect(Bun.stripANSI(mode.chatContainer.render(120).join("\n"))).toContain("(no output)");
	});

	it("re-keys a streamed tool card when its id grows across deltas (piped copilot id)", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall("call-x")], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: assistantMessage([bashToolCall("call-x")], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall("call-x|abc123==")], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: assistantMessage([bashToolCall("call-x|abc123==")], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(countCommand(mode)).toBe(1);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([bashToolCall("call-x|abc123==")], "toolUse"),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await runToolCallToCompletion("call-x|abc123==");
		expect(countCommand(mode)).toBe(1);
	});
});
