import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import type { TUI } from "@oh-my-pi/pi-tui";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: zeroUsage(),
		stopReason: undefined,
		createdAt: new Date(0),
	} as unknown as AssistantMessage;
}

function messageUpdate(text: string): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		message: assistantMessage(text),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistantMessage(text) },
	} as unknown as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function createStreamingFixture() {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
	} as unknown as TUI;
	const viewSession = { isStreaming: true, getToolByName: () => undefined };
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui,
		settings,
		chatContainer: { addChild: vi.fn(), children: [] },
		pendingTools: new Map(),
		transcriptMessageComponents: new WeakMap(),
		streamingComponent: {
			setHideThinkingBlock: vi.fn(),
			markTranscriptBlockFinalized: vi.fn(),
			updateContent: vi.fn(),
		},
		noteDisplayableThinkingContent: vi.fn(() => false),
		ensureLoadingAnimation: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		setWorkingMessage: vi.fn(),
		viewSession,
		session: {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
		} as unknown as InteractiveModeContext["session"],
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	controller.subscribeToAgent();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) void listener(event);
	};
	return { controller, ctx, ui, emit };
}

describe("EventController message_update coalescing", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("runs the streaming rebuild once per window instead of once per delta, applying the latest snapshot", async () => {
		const { ctx, ui, emit } = createStreamingFixture();

		emit(messageUpdate("tok1"));
		emit(messageUpdate("tok1 tok2"));
		emit(messageUpdate("tok1 tok2 tok3"));
		emit(messageUpdate("tok1 tok2 tok3 tok4"));
		emit(messageUpdate("tok1 tok2 tok3 tok4 tok5"));

		// The coalescing window is 33ms; give the trailing flush a chance to fire.
		await Bun.sleep(60);

		expect(ui.requestRender).toHaveBeenCalledTimes(1);
		expect((ctx.streamingMessage as AssistantMessage | undefined)?.content).toEqual([
			{ type: "text", text: "tok1 tok2 tok3 tok4 tok5" },
		]);
	});

	it("flushes the pending snapshot before a subsequent non-update event", async () => {
		const { ctx, emit } = createStreamingFixture();

		emit(messageUpdate("tok1"));
		emit(messageUpdate("tok1 tok2"));
		emit({ type: "message_end", message: assistantMessage("tok1 tok2") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect((ctx.streamingMessage as AssistantMessage | undefined)?.content).toEqual([
			{ type: "text", text: "tok1 tok2" },
		]);
	});

	it("speaks every delta exactly once even when intermediate snapshots are coalesced away", async () => {
		const { emit } = createStreamingFixture();
		const pushDelta = vi.spyOn(vocalizer, "pushDelta");
		settings.set("speech.enabled", true);
		settings.set("speech.mode", "assistant");

		emit(messageUpdate("one "));
		emit(messageUpdate("one two "));
		emit(messageUpdate("one two three "));

		await Bun.sleep(60);

		expect(pushDelta).toHaveBeenCalledTimes(3);
		expect(pushDelta).toHaveBeenNthCalledWith(1, "one ");
		expect(pushDelta).toHaveBeenNthCalledWith(2, "one two ");
		expect(pushDelta).toHaveBeenNthCalledWith(3, "one two three ");
	});

	it("serializes a tail event behind an in-flight window flush", async () => {
		// The coalesced flush fires from a 33ms timer, NOT from the listener
		// path, so AgentSession's fire-and-forget dispatch cannot serialize it:
		// a message_end landing mid-flush used to run its handler concurrently,
		// both calling init while the flush was suspended. The dispatch chain
		// must hold the tail event until the window flush completed.
		const { ctx, emit } = createStreamingFixture();
		ctx.isInitialized = false;
		const initGate = Promise.withResolvers<void>();
		let initCalls = 0;
		ctx.init = vi.fn(async () => {
			initCalls += 1;
			if (initCalls === 1) await initGate.promise;
		});

		emit(messageUpdate("tok1 tok2"));
		await Bun.sleep(45); // window fires; flush suspends on init (call 1)

		emit({ type: "message_end", message: assistantMessage("tok1 tok2") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		await Bun.sleep(0);

		// The end handler must be queued behind the suspended flush, not
		// running alongside it (which would double-init).
		expect(initCalls).toBe(1);
		initGate.resolve();
		await Bun.sleep(0);

		// Flush completed, then the end handler ran to completion.
		expect(initCalls).toBe(2);
	});
});
