import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const recordToolSchema = type({ value: type("string") });

type Harness = {
	session: AgentSession;
	tempDir: TempDir;
};
type SettingsOverrides = Record<string, unknown>;

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

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function unexpectedStop(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

function thinkingOnlyStop(thinking: string): MockResponse {
	return {
		content: [{ type: "thinking", thinking, thinkingSignature: "reasoning_content" }],
		stopReason: "stop",
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-unexpected-stop-guard-");

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
		...settingsOverrides,
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
		getToolChoice: () => session?.nextToolChoiceDirective(),
		streamFn: mock.stream,
	});
	const agentSession = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const session = agentSession;
	const harness = { session: agentSession, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message =>
			Array.isArray(message.content)
				? message.content.flatMap(content => (content.type === "text" ? [content.text] : []))
				: [],
		)
		.join("\n");
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message): message is Extract<AgentMessage, { role: "developer" }> => {
		if (message.role !== "developer") return false;
		const text =
			(typeof message.content === "string"
				? message.content
				: message.content.find((content): content is { type: "text"; text: string } => content.type === "text")
						?.text) ?? "";
		return text.includes("You said you would continue");
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	activeHarnesses.length = 0;
});

describe("AgentSession unexpected stop guard", () => {
	it("does not retry or request an auxiliary model when the mode is none", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness(
			[unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now.")],
			{
				"features.unexpectedStopDetection": "none",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("defaults to mechanical mode and retries on thinking-only stops without classification", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness([
			thinkingOnlyStop("思考中..."),
			{ content: ["done now"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("delivers retries scheduled by consecutive thinking-only stops before going idle", async () => {
		const { session, mock } = await createHarness([
			thinkingOnlyStop("first thought"),
			thinkingOnlyStop("second thought"),
			thinkingOnlyStop("third thought"),
			{ content: ["finished after retries"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(assistantText(session.agent.state.messages)).toContain("finished after retries");
	});

	it("retries a stop whose only content is signed thinking with empty text", async () => {
		const { session, mock } = await createHarness([
			thinkingOnlyStop(""),
			{ content: ["finished after reasoning-only stop"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("finished after reasoning-only stop");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		// The signed reasoning stays in context so the continuation replays it.
		const assistants = session.agent.state.messages.filter(message => message.role === "assistant");
		expect(assistants[0]?.content).toEqual([
			{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
		]);
	});

	it("does not retry in mechanical mode when text message was delivered", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness([
			unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now."),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("does not retry after a forced tool call", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-forced"),
			{ content: ["recorded"], stopReason: "stop" },
		]);
		session.setForcedToolChoice("record");

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(mock.calls.map(call => call.options?.toolChoice)).toEqual([{ type: "tool", name: "record" }, "none"]);
		expect(spy).not.toHaveBeenCalled();
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("migrates legacy smart mode to mechanical recovery and stops when the retry is aborted", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness(
			[thinkingOnlyStop(" 响应"), { content: ["done now"], stopReason: "aborted" }],
			{
				"features.unexpectedStopDetection": "smart",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("caps unexpected stop retries at three attempts", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness(
			[
				thinkingOnlyStop("first thought"),
				thinkingOnlyStop("second thought"),
				thinkingOnlyStop("third thought"),
				thinkingOnlyStop("fourth thought"),
			],
			{
				"features.unexpectedStopDetection": "mechanical",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("does not retry a delivered tool call", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness(
			[recordCall("alpha", "call-record-alpha"), { content: ["tool path complete"], stopReason: "aborted" }],
			{
				"features.unexpectedStopDetection": "mechanical",
			},
		);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it.each(["length", "aborted"] as const)("does not retry a %s stop", async stopReason => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected auxiliary model request"));
		const { session, mock } = await createHarness(
			[{ content: ["I should continue but was interrupted"], stopReason }],
			{
				"features.unexpectedStopDetection": "mechanical",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});
});
