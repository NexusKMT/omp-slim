/**
 * Regression #9816: while a subagent is focused, the TUI is unsubscribed from
 * the main AgentSession. A main-session tool completion can therefore be emitted
 * with no display listener while its following tool-result `message_end` is
 * still being persisted. Returning immediately used to rebuild from the stale
 * dangling toolCall, classify the now-idle session as historical, and seal a
 * permanent `all running jobs` card.
 *
 * Contract: focus attach subscribes to the target, drains its in-flight event
 * handlers/persistence, then rebuilds. A completion already emitted during the
 * focus blackout is authoritative in the rebuilt transcript; a later event is
 * delivered through the newly installed subscription.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const danglingHubWait = {
	role: "assistant",
	content: [{ type: "toolCall", id: "hub-1", name: "hub", arguments: { op: "wait" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

const completedHubWait = {
	role: "toolResult",
	toolCallId: "hub-1",
	toolName: "hub",
	content: [{ type: "text", text: "Completed (1)" }],
	details: {
		op: "wait",
		jobs: [
			{
				id: "Sleeper1",
				type: "task",
				status: "completed",
				label: "Sleeper1",
				durationMs: 11_300,
			},
		],
	},
	isError: false,
	timestamp: Date.now(),
} as ToolResultMessage;

const danglingTask = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "task-1",
			name: "task",
			arguments: {
				tasks: [{ name: "Parent", agent: "task", task: "Inspect the focus rebuild" }],
			},
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

function runningProgress(id: string, description: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: description,
		description,
		currentTool: "read",
		currentToolArgs: "packages/coding-agent/src/modes",
		recentTools: [],
		recentOutput: [],
		toolCount: 4,
		requests: 3,
		tokens: 1200,
		cost: 0.04,
		durationMs: 2500,
		...overrides,
	};
}

const nestedProgress: TaskToolDetails = {
	projectAgentsDir: null,
	results: [],
	totalDurationMs: 2500,
	progress: [runningProgress("Parent.Child", "Inspect child layout")],
};

const taskProgressUpdate = {
	type: "tool_execution_update",
	toolCallId: "task-1",
	toolName: "task",
	args: { tasks: [{ name: "Parent", agent: "task", task: "Inspect the focus rebuild" }] },
	partialResult: {
		content: [{ type: "text", text: "Running 1 agent..." }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 2500,
			progress: [
				runningProgress("Parent", "Inspect parent layout", {
					inflightTaskDetails: nestedProgress,
				}),
			],
		} satisfies TaskToolDetails,
	},
} satisfies Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

interface SessionStub {
	session: AgentSession;
	hasListener(): boolean;
	emitToolUpdate(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): Promise<void>;
	stagePersistedCompletion(): () => void;
}

function makeSession(initialMessages: AgentMessage[], initialStreaming: boolean): SessionStub {
	let messages = initialMessages;
	let streaming = initialStreaming;
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let persistence = Promise.resolve();
	const activeToolUpdates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();

	const stub = {
		get isStreaming() {
			return streaming;
		},
		retryAttempt: 0,
		subscribe(next: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = next;
			return () => {
				if (listener === next) listener = undefined;
			};
		},
		async settleInFlightMessagePersistence() {
			await persistence;
		},
		buildTranscriptSessionContext() {
			return { messages } as SessionContext;
		},
		getToolByName: () => undefined,
		activeToolExecutionUpdates: () => [...activeToolUpdates.values()],
		hasBuiltInTool: () => true,
		sessionManager: {
			getCwd: () => process.cwd(),
			getEntries: () => messages,
		},
	};

	return {
		session: stub as unknown as AgentSession,
		hasListener: () => listener !== undefined,
		emitToolUpdate: async event => {
			activeToolUpdates.set(event.toolCallId, event);
			await listener?.(event);
		},
		stagePersistedCompletion: () => {
			streaming = false;
			const pending = Promise.withResolvers<void>();
			persistence = pending.promise;
			return () => {
				messages = [danglingHubWait, completedHubWait];
				pending.resolve();
			};
		},
	};
}

function createFixture(main = makeSession([danglingHubWait], true)) {
	const worker = makeSession([], false);
	const registry = new AgentRegistry();
	registry.register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: worker.session,
		status: "running",
	});
	const lifecycle = new AgentLifecycleManager(registry);
	let helpers!: UiHelpers;
	let focus!: SessionFocusController;
	let eventController!: EventController;
	const pendingMessagesContainer = new TranscriptContainer();
	const pendingTools = new Map();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		session: main.session,
		get viewSession() {
			return focus?.target ?? main.session;
		},
		chatContainer: new TranscriptContainer(),
		pendingMessagesContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		pendingBashComponents: [],
		pendingPythonComponents: [],
		initialChatRendered: false,
		hideToolActivity: false,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), setSession: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		renderSessionContext: (context: SessionContext, options?: unknown) =>
			helpers.renderSessionContext(context, options as never),
		renderSessionContextIncrementally: (context: SessionContext, options: unknown, renderChunk?: () => void) =>
			helpers.renderSessionContextIncrementally(context, options as never, renderChunk),
		reloadTodos: vi.fn(async () => {}),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		lastAssistantUsage: undefined,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		setTodos: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		clearPinnedError: vi.fn(),
		clearTransientSessionUi: () => {
			pendingMessagesContainer.disposeChildren();
			pendingTools.clear();
		},
		updateEditorTopBorder: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
	} as unknown as InteractiveModeContext;

	helpers = new UiHelpers(ctx);
	eventController = new EventController(ctx);
	ctx.eventController = eventController;
	ctx.renderInitialMessages = options => helpers.renderInitialMessages(options);
	focus = new SessionFocusController(ctx, registry, () => lifecycle);
	ctx.unsubscribe = main.session.subscribe(event => eventController.handleEvent(event));
	return { ctx, focus, main };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("#9816 focus blackout across an in-flight hub wait", () => {
	it("drains a lost completion into the transcript before rebuilding the main session", async () => {
		const { ctx, focus, main } = createFixture();
		await ctx.renderInitialMessages();
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain("all running jobs");

		await focus.focusAgent("Worker");
		expect(main.hasListener()).toBe(false);

		// The main wait completes while its TUI listener is detached. AgentSession
		// has emitted the terminal display event but its following tool-result
		// message_end is still persisting.
		const finishPersistence = main.stagePersistedCompletion();
		const returning = focus.unfocus();
		queueMicrotask(finishPersistence);
		await returning;

		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("1 job settled");
		expect(rendered).toContain("Sleeper1");
		expect(rendered).not.toContain("all running jobs");
		expect(ctx.pendingTools.has("hub-1")).toBe(false);
	});
});

describe("#10446 task progress across a focus rebuild", () => {
	it("restores the latest in-flight task board after returning to main", async () => {
		const main = makeSession([danglingTask], true);
		const fixture = createFixture(main);

		await fixture.ctx.renderInitialMessages();
		await main.emitToolUpdate(taskProgressUpdate);
		const before = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(before).toContain("Parent>Child");
		expect(before).toContain("packages/coding-agent/src/modes");

		await fixture.focus.focusAgent("Worker");
		await fixture.focus.unfocus();

		const after = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(after).toContain("Parent>Child");
		expect(after).toContain("packages/coding-agent/src/modes");
	});
});
