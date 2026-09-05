import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ContextNotesTool, NewContextTool } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("anthropic", "test-key");
authStorage.setRuntimeApiKey("openai-codex", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("experimental context management", () => {
	let session: AgentSession | undefined;

	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	async function createCodeModeSession() {
		const mock = createMockModel({
			responses: [
				{
					content: ["Working on the task. ".repeat(100), { type: "toolCall", name: "new_context", arguments: {} }],
				},
				{ content: ["done"] },
			],
		});
		const manager = SessionManager.inMemory();
		const history = [user("old task"), assistant("old result")];
		for (const message of history) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 128,
			"compaction.midTurnEnabled": false,
			"providers.openai-codex.codeMode": "on",
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const tools: Tool[] = [
			new ReadTool(toolSession),
			new GrepTool(toolSession),
			new ContextNotesTool(toolSession),
			new NewContextTool(toolSession),
			new EvalTool(toolSession),
		];
		const model = { ...mock.model, provider: "openai-codex" };
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], tools, messages: history },
			getApiKey: () => "test-key",
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});
		await session.setActiveToolsByName(tools.map(tool => tool.name));
		return { session, manager, mock };
	}

	it("exposes new_context directly in Code Mode and rolls over once below the automatic threshold", async () => {
		const { session, manager, mock } = await createCodeModeSession();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});
		expect(session.getActiveToolNames()).toContain("new_context");
		expect(session.getActiveToolNames()).not.toContain("read");
		const request = "Implement the task; preserve the public API and do not deploy.";
		await session.prompt(request);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0].context.tools?.some(tool => tool.name === "new_context")).toBe(true);
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "auto_compaction_end")).toMatchObject([
			{ aborted: false, willRetry: false },
		]);
		expect(
			mock.calls[1].context.messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes(request),
			),
		).toHaveLength(1);
		expect(
			mock.calls[1].context.messages.some(message => message.role === "user" && message.content === "old task"),
		).toBe(false);
	});

	it("retains the latest request through successive rollovers and context reconstruction without notes", async () => {
		const { session, manager, mock } = await createCodeModeSession();
		const request = "Keep the API compatible; implement this task without deploying.";
		await session.prompt(request);
		await session.waitForIdle();
		const moreWork = assistant("More progress on the same task. ".repeat(100));
		manager.appendMessage(moreWork);
		session.agent.replaceMessages([...session.agent.state.messages, moreWork]);
		await session.compact();
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes(request),
			),
		).toHaveLength(1);
		const rebuilt = manager.buildSessionContext().messages;
		expect(
			rebuilt.filter(message => message.role === "user" && JSON.stringify(message.content).includes(request)),
		).toHaveLength(1);
	});

	it("closes the lifecycle when cancellation occurs during awaited start dispatch", async () => {
		const { session, manager } = await createCodeModeSession();
		const events: AgentSessionEvent[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		session.subscribe(async event => {
			if (event.type !== "auto_compaction_start" && event.type !== "auto_compaction_end") return;
			events.push(event);
			if (event.type === "auto_compaction_start") {
				started.resolve();
				await release.promise;
			}
		});
		const prompt = session.prompt("continue the task");
		try {
			await started.promise;
			expect(session.isCompacting).toBe(true);
			session.abortCompaction();
		} finally {
			release.resolve();
		}
		await prompt;
		await session.waitForIdle();
		expect(events).toMatchObject([
			{ type: "auto_compaction_start" },
			{ type: "auto_compaction_end", aborted: true, willRetry: false },
		]);
		expect(events).toHaveLength(2);
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
		expect(session.isCompacting).toBe(false);
	});
	it("keeps raw history and the latest notebook through two real rollover boundaries", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const first = [user("first task"), assistant("first result"), user("second task"), assistant("second result")];
		for (const message of first) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 1,
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const tools: Tool[] = [
			new ReadTool(toolSession),
			new GrepTool(toolSession),
			new ContextNotesTool(toolSession),
			new NewContextTool(toolSession),
		];
		const toolRegistry = new Map<string, AgentTool>(tools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], tools, messages: first },
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry,
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});

		await session.compact();
		manager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text: "Keep the first result." });
		const second = [user("third task"), assistant("third result"), user("fourth task"), assistant("fourth result")];
		for (const message of second) manager.appendMessage(message);
		agent.replaceMessages([...agent.state.messages, ...second]);
		await session.compact();

		const boundaries = manager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(boundaries.map(entry => entry.details)).toEqual([
			{ kind: "experimental-context-rollover", version: 1 },
			{ kind: "experimental-context-rollover", version: 1 },
		]);
		expect(boundaries).toHaveLength(2);
		expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(first.length + second.length);
		const notebook = agent.state.messages.find(
			message => message.role === "custom" && message.customType === CONTEXT_NOTES_ENTRY_TYPE,
		);
		if (notebook?.role !== "custom") throw new Error("Expected persisted context notebook");
		expect(notebook?.content).toContain("Keep the first result.");
	});
});
