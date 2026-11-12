import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const recordToolSchema = type({ value: type("string") });

type Harness = { session: AgentSession; tempDir: TempDir };

const activeHarnesses: Harness[] = [];
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("mock", "test-key");
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

const recordTool: AgentTool<typeof recordToolSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordToolSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `recorded:${params.value}` }],
			details: { value: params.value },
		};
	},
};

function signedThinkingWithToolCall(id: string): MockResponse {
	return {
		content: [
			{ type: "thinking", thinking: "reasoning before tool", thinkingSignature: "reasoning_content" },
			{ type: "toolCall", id, name: "record", arguments: { value: "x" } },
		],
		stopReason: "toolUse",
	};
}

function finalText(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

async function createHarness(responses: MockResponse[]): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-thinking-persistence-repro-");

	const mock = createMockModel({ responses });
	const modelRegistry = sharedModelRegistry;
	const getAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => (kind === "all" ? [mock] : getAvailable(kind)));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5") ?? mock;
	const modelSelector = `${model.provider}/${model.id}`;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
		model: modelSelector,
	});

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		getToolChoice: () => undefined,
		streamFn: mock.stream,
	});
	const agentSession = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session: agentSession, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	activeHarnesses.length = 0;
});

function assistants(messages: AgentMessage[]): Array<Extract<AgentMessage, { role: "assistant" }>> {
	return messages.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant");
}

describe("thinking persistence across turns", () => {
	it("keeps signed thinking through storage and into the LLM view", async () => {
		const { session, mock } = await createHarness([
			signedThinkingWithToolCall("call-1"),
			finalText("done now"),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();
		await session.prompt("follow up");
		await session.waitForIdle();

		expect(mock.calls.length).toBeGreaterThanOrEqual(2);

		const stored = assistants(session.agent.state.messages);
		const llm = convertToLlm(session.agent.state.messages);
		const llmAssistants = llm.filter(m => m.role === "assistant");

		// The signed thinking block must survive both the persisted session state
		// and the LLM view so the encoder can replay reasoning_content (DeepSeek
		// endpoints 400 on follow-up turns that omit it).
		const first = stored[0];
		expect(first?.content).toContainEqual({
			type: "thinking",
			thinking: "reasoning before tool",
			thinkingSignature: "reasoning_content",
		});
		expect(
			llmAssistants.some(
				m =>
					Array.isArray(m.content) &&
					m.content.some(
						block =>
							block.type === "thinking" &&
							"thinking" in block &&
							block.thinking === "reasoning before tool" &&
							"thinkingSignature" in block &&
							block.thinkingSignature === "reasoning_content",
					),
			),
		).toBe(true);
	});
});
