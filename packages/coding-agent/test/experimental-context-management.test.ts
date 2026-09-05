import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
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
