import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ContextViewData } from "@oh-my-pi/pi-tui/chrome/context-view-model";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import { AgentSession } from "../../src/session/agent-session";
import { computeSessionContextBreakdown } from "../../src/session/context-usage-runtime";
import { buildSessionContextView } from "../../src/session/context-view";
import { SessionManager } from "../../src/session/session-manager";
import { buildSystemPrompt } from "../../src/system-prompt";
import { createTestModel } from "../helpers/test-model";

const model = createTestModel({ provider: "anthropic", id: "claude-sonnet-4-5" })!;
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: type({ value: "string" }),
		async execute() {
			return { content: [{ type: "text", text: "result" }] };
		},
	};
}

function sessionWith(
	options: {
		prompt?: string[];
		skills?: Skill[];
		messages?: AgentMessage[];
		tools?: AgentTool[];
		settings?: Settings;
		model?: Model;
	} = {},
): AgentSession {
	const tools = options.tools ?? [];
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: options.model ?? model,
				systemPrompt: options.prompt ?? ["opaque system"],
				tools,
				messages: options.messages ?? [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		builtInToolNames: ["read"],
		skills: options.skills,
	});
	sessions.push(session);
	return session;
}

function category(data: ContextViewData, id: string) {
	return data.categories.find(category => category.id === id)!;
}

function totalTokens(data: ContextViewData): number {
	return data.categories.reduce((sum, category) => sum + category.tokens, 0);
}

const reply = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 24,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 24,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 10,
});

describe("context snapshot capacity and savings", () => {
	it("keeps provider-anchored capacity when raw prompt estimates exceed the window", () => {
		const message = reply([{ type: "text", text: "saved answer" }]);
		message.usage.input = 100;
		message.usage.totalTokens = 124;
		const session = sessionWith({
			prompt: ["large prompt ".repeat(120000)],
			messages: [message],
			settings: Settings.isolated({ "compaction.enabled": true, "todo.enabled": false }),
		});
		const data = buildSessionContextView(session);
		const { breakdown } = data;
		expect(totalTokens(data)).toBeGreaterThan(breakdown.contextWindow);
		expect(breakdown.usedTokens).toBe(100);
		expect(breakdown.autoCompactBufferTokens).toBeGreaterThan(0);
		expect(breakdown.freeTokens + breakdown.autoCompactBufferTokens).toBe(breakdown.contextWindow - 100);
	});
});

describe("context snapshot system prompt and skills", () => {
	it("retains effective system blocks and skill content without file I/O", async () => {
		const skills: Skill[] = [
			{
				name: "fixture",
				description: "Use <T> & {{literal}} without expansion",
				filePath: "/nonexistent/SKILL.md",
				baseDir: "/nonexistent",
				source: "user",
			},
		];
		const built = await buildSystemPrompt({
			cwd: import.meta.dir,
			activeRepoContext: null,
			contextFiles: [{ path: "/nonexistent/instructions.md", content: "Unique instruction body" }],
			skills,
		});
		const prompt = [...built.systemPrompt, "Additional effective policy"];
		const session = sessionWith({ prompt, skills, tools: [tool("read")] });
		const file = vi.spyOn(Bun, "file");
		const data = buildSessionContextView(session);
		const system = category(data, "system-prompt");
		expect(system.entries.map(entry => entry.text)).toEqual(prompt);
		expect(system.entries.map(entry => entry.tokens)).toEqual(
			prompt.map(block => session.agent.tokenizer.countTokens(block)),
		);
		const text = system.entries.map(entry => entry.text).join("\n");
		expect(text).toContain("Unique instruction body");
		expect(text).toContain("Use <T> & {{literal}} without expansion");
		const shared = computeSessionContextBreakdown(session).categories.find(category => category.id === "skills")!;
		expect(shared.tokens).toBeGreaterThan(0);
		expect(category(data, "skills")).toMatchObject({ entries: [], tokens: shared.tokens });
		const fullPromptTokens = system.entries.reduce((sum, entry) => sum + entry.tokens, 0);
		expect(system.tokens).toBe(fullPromptTokens - shared.tokens);
		expect(system.tokens + category(data, "skills").tokens).toBe(fullPromptTokens);
		expect(totalTokens(data)).toBe(fullPromptTokens + category(data, "built-in-tools").tokens);
		expect(file).not.toHaveBeenCalled();
		file.mockRestore();
	});

	it("clamps the System Prompt total when the shared Skills estimate exceeds the effective blocks", () => {
		const session = sessionWith({
			prompt: [""],
			tools: [tool("read")],
			skills: [
				{
					name: "fixture",
					description: "A nonempty skill description",
					filePath: "/nonexistent/SKILL.md",
					baseDir: "/nonexistent",
					source: "user",
				},
			],
		});
		const data = buildSessionContextView(session);
		expect(category(data, "skills").tokens).toBeGreaterThan(0);
		expect(category(data, "skills").entries).toEqual([]);
		expect(category(data, "system-prompt")).toMatchObject({
			tokens: 0,
			entries: [{ id: "system-prompt/0", text: "", tokens: 0 }],
		});
	});
});

describe("context snapshot tool schemas", () => {
	it("keeps a tool inspectable when its schema is cyclic", () => {
		const broken = tool("cyclic");
		const schema: Record<string, unknown> = {};
		schema.self = schema;
		broken.parameters = schema as never;
		const session = sessionWith({ tools: [broken] });
		const data = buildSessionContextView(session);
		expect(category(data, "custom-tools").entries[0]?.text).toContain("Schema unavailable");
	});

	it("charges tool definitions what the usage breakdown charges the roster", () => {
		const session = sessionWith({ tools: [tool("first"), tool("second")] });
		const data = buildSessionContextView(session);
		const definitions = [...category(data, "built-in-tools").entries, ...category(data, "custom-tools").entries];
		const roster = data.breakdown.categories.find(item => item.id === "systemTools")!.tokens;
		expect(roster).toBeGreaterThan(0);
		expect(definitions.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(roster);
	});
});

describe("context snapshot assistant reasoning", () => {
	it("separates assistant blocks without charging reasoning usage repeatedly and shows only signature sizes", () => {
		const message = reply([
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "readable thought", thinkingSignature: "private-signature" },
			{ type: "thinking", thinking: "", thinkingSignature: "private-encoded-thinking" },
			{ type: "redactedThinking", data: "private-ciphertext" },
			{ type: "toolCall", name: "read", id: "duplicate", arguments: { path: "notes.txt" } },
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-messages").entries.map(entry => entry.text)).toEqual(["visible answer"]);
		const thinking = category(data, "assistant-thinking").entries;
		expect(thinking[0]?.text).toBe("readable thought");
		// Signature-only and redacted blocks still get readable placeholder text.
		for (const entry of thinking.slice(1)) expect(entry.text.trim()).not.toBe("");
		// Signature and ciphertext blocks show their size and nothing else.
		expect(thinking.map(entry => entry.info)).toEqual([
			expect.stringContaining("17"),
			expect.stringContaining("24"),
			expect.stringContaining("18"),
		]);
		expect(category(data, "tool-calls").entries[0]?.text).toContain('"path": "notes.txt"');
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
		expect(JSON.stringify(data)).not.toMatch(/private-signature|private-encoded-thinking|private-ciphertext/);
	});

	it.each([
		{ name: "unmeasured interruption", reasoningTokens: undefined, interrupted: true },
		{ name: "measured zero", reasoningTokens: 0, interrupted: false },
	])("distinguishes empty thinking with zero usage: $name", ({ reasoningTokens, interrupted }) => {
		const message: AssistantMessage = {
			...reply([{ type: "thinking", thinking: "" }]),
			stopReason: "aborted",
			usage: { ...reply([]).usage, output: 0, totalTokens: 0, reasoningTokens },
		};
		const data = buildSessionContextView(sessionWith({ prompt: [], messages: [message] }));
		const thinking = category(data, "assistant-thinking");
		expect(thinking.tokens).toBe(0);
		expect(thinking.entries[0]?.interrupted).toBe(interrupted);
	});
});

describe("context snapshot message projection and snapshots", () => {
	it("keeps a tool call without arguments inspectable and charges no phantom thinking", () => {
		const call = { type: "toolCall", name: "read", id: "call", arguments: undefined };
		const assistant = reply([call as unknown as AssistantMessage["content"][number]]);
		const data = buildSessionContextView(sessionWith({ messages: [assistant] }));
		expect(category(data, "tool-calls").entries[0]).toMatchObject({ label: "read", text: "null" });
		expect(category(data, "assistant-thinking").entries).toEqual([]);
	});

	it("keeps included bash execution output while excluding python executions", () => {
		const messages: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo kept",
				output: "saved stdout",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "print('excluded')",
				output: "hidden",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
		];
		const session = sessionWith({ messages });
		const data = buildSessionContextView(session);
		expect(category(data, "tool-output").children?.map(group => group.label)).toEqual(["bash"]);
		expect(category(data, "tool-output").entries[0]?.text).toContain("saved stdout");
		expect(JSON.stringify(data)).not.toContain("excluded");
	});

	it("counts original image content rather than its display summary without exposing binary data", () => {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
			timestamp: 5,
		};
		const session = sessionWith({ messages: [message] });
		const data = buildSessionContextView(session);
		const users = category(data, "user-messages").entries;
		expect(users).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("image/png"),
				tokens: session.agent.tokenizer.countMessages([message]),
			}),
		]);
		expect(JSON.stringify(data)).not.toContain("aGVsbG8=");
	});
});

describe("context snapshot tool calls and output", () => {
	it("groups retained server-tool calls and results while replacing provider ciphertext with its size", () => {
		const message = reply([
			{
				type: "anthropicServerTool",
				block: { type: "server_tool_use", id: "search", name: "web_search", input: { query: "release notes" } },
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "tools",
					name: "tool_search_tool_regex",
					input: { pattern: "read.*" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "tool_search_tool_result",
					tool_use_id: "tools",
					content: [{ type: "tool_reference", tool_name: "read_file" }],
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "search",
					content: [
						{
							type: "web_search_result",
							title: "Release notes",
							url: "https://example.org/releases",
							encrypted_content: "private-ciphertext",
							signature: "private-signature",
						},
					],
				},
			},
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const before = structuredClone(message);
		const data = buildSessionContextView(session);
		const calls = category(data, "tool-calls").entries;
		expect(calls.map(entry => [entry.label, entry.callId])).toEqual([
			["web_search", "search"],
			["tool_search_tool_regex", "tools"],
		]);
		expect(JSON.parse(calls[0]!.text).input).toEqual({ query: "release notes" });
		const results = category(data, "tool-output");
		expect(results.entries.map(entry => [entry.label, entry.callId, entry.timestamp])).toEqual([
			["tool_search_tool_regex", "tools", message.timestamp],
			["web_search", "search", message.timestamp],
		]);
		expect(JSON.parse(results.entries[0]!.text).content).toEqual([
			{ type: "tool_reference", tool_name: "read_file" },
		]);
		const [shown] = JSON.parse(results.entries[1]!.text).content;
		expect(shown).toMatchObject({
			type: "web_search_result",
			title: "Release notes",
			url: "https://example.org/releases",
		});
		// Ciphertext fields keep their size but never their bytes.
		expect(shown.encrypted_content).toContain("18");
		expect(shown.signature).toContain("17");
		expect(JSON.stringify(data)).not.toMatch(/private-ciphertext|private-signature/);
		expect(category(data, "assistant-messages").entries).toEqual([]);
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
		expect(message).toEqual(before);
	});

	it("sorts tool groups by token totals and saved results by timestamp then conversation order", () => {
		const result = (name: string, text: string, timestamp: number): AgentMessage => ({
			role: "toolResult",
			toolName: name,
			toolCallId: "duplicate",
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
		});
		const session = sessionWith({
			messages: [
				result("small", "b", 20),
				result("large", "large ".repeat(100), 30),
				result("small", "a", 10),
				result("small", "c", 20),
			],
		});
		const output = category(buildSessionContextView(session), "tool-output");
		expect(output.children?.map(group => group.label)).toEqual(["large", "small"]);
		expect(output.children?.[1]?.entries.map(entry => entry.text)).toEqual(["a", "b", "c"]);
		expect(output.entries.map(entry => entry.text)).toEqual(["a", "b", "c", "large ".repeat(100)]);
		expect(new Set(output.entries.map(entry => entry.id)).size).toBe(4);
		expect(output.tokens).toBe(output.children!.reduce((sum, group) => sum + group.tokens, 0));
	});
});
