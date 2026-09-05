import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CONTEXT_NOTES_ENTRY_TYPE, getContextNotes } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ContextNotesTool, NewContextTool } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("anthropic", "test-key");
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
	it("keeps exact earlier requirements and the latest notebook through three real rollover boundaries", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const first = [
			user("earliest requirement: preserve the release-blocking migration."),
			assistant("first result"),
			user("second task"),
			assistant("second result"),
		];
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
		const notesTool = new ContextNotesTool(toolSession);
		const readTool = new ReadTool(toolSession);
		const tools: Tool[] = [readTool, new GrepTool(toolSession), notesTool, new NewContextTool(toolSession)];
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
		await notesTool.execute("notebook-one", { text: "First rollover notebook." });
		const second = [user("third task"), assistant("third result"), user("fourth task"), assistant("fourth result")];
		for (const message of second) manager.appendMessage(message);
		agent.replaceMessages([...agent.state.messages, ...second]);
		await session.compact();
		await notesTool.execute("notebook-two", { text: "Second rollover notebook." });
		const third = [user("fifth task"), assistant("fifth result"), user("sixth task"), assistant("sixth result")];
		for (const message of third) manager.appendMessage(message);
		agent.replaceMessages([...agent.state.messages, ...third]);
		await notesTool.execute("notebook-latest", {
			text: "Latest durable notebook: retry only after migration backup.",
		});
		await session.compact();

		const boundaries = manager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(boundaries.map(entry => entry.details)).toEqual([
			{ kind: "experimental-context-rollover", version: 1 },
			{ kind: "experimental-context-rollover", version: 1 },
			{ kind: "experimental-context-rollover", version: 1 },
		]);
		expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(
			first.length + second.length + third.length,
		);

		const history = await readTool.execute("retrieve-earliest-requirement", { path: "history://current/full" });
		const historyText = history.content.find(content => content.type === "text");
		if (historyText?.type !== "text") throw new Error("Expected full history text");
		expect(historyText.text).toContain("earliest requirement: preserve the release-blocking migration.");

		expect(getContextNotes(manager.getBranch())?.text).toBe(
			"Latest durable notebook: retry only after migration backup.",
		);
		const notebook = agent.state.messages.find(
			message => message.role === "custom" && message.customType === CONTEXT_NOTES_ENTRY_TYPE,
		);
		if (notebook?.role !== "custom") throw new Error("Expected persisted context notebook");
		expect(notebook.content).toContain("Latest durable notebook: retry only after migration backup.");
	});

	it("consumes a new context request only after every tool result in its batch is journaled", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const seed = [
			user("first task"),
			assistant("first result ".repeat(512)),
			user("second task"),
			assistant("second result"),
		];
		for (const message of seed) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 512,
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
		const contextNotes = new ContextNotesTool(toolSession);
		const newContext = new NewContextTool(toolSession);
		const tools: Tool[] = [new ReadTool(toolSession), new GrepTool(toolSession), contextNotes, newContext];
		const observedContexts: string[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools, messages: seed },
			convertToLlm,
			streamFn: (_model, context) => {
				providerCalls++;
				if (providerCalls === 2) observedContexts.push(JSON.stringify(context.messages));
				const reason = providerCalls === 1 ? "toolUse" : "stop";
				const message = assistant("Rollover completed after the tool batch.");
				message.stopReason = reason;
				if (reason === "toolUse") {
					message.content = [
						{
							type: "toolCall",
							id: "batch-notes",
							name: "context_notes",
							arguments: { text: "Notebook saved with the request." },
						},
						{ type: "toolCall", id: "batch-rollover", name: "new_context", arguments: {} },
					];
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});

		await session.prompt("save the notebook and roll over");

		const branch = manager.getBranch();
		expect(
			branch.filter(
				entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
			),
		).toEqual([]);
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		const batchToolResultIndexes = branch
			.map((entry, index) => ({ entry, index }))
			.filter(
				({ entry }) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					(entry.message.toolCallId === "batch-notes" || entry.message.toolCallId === "batch-rollover"),
			)
			.map(({ index }) => index);
		expect(providerCalls).toBe(2);
		expect(batchToolResultIndexes).toHaveLength(2);
		expect(compactionIndex).toBeGreaterThan(Math.max(...batchToolResultIndexes));
		expect(getContextNotes(branch)?.text).toBe("Notebook saved with the request.");
		expect(observedContexts.join("\n")).toContain("history://current/full");
		expect(observedContexts.join("\n")).toContain("Notebook saved with the request.");
	});
});
