import { afterAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/**
 * Live end-to-end session test: real provider, real streaming, real persistence.
 *
 * Gate: skipped unless LIVE_OPENAI_BASE_URL and LIVE_OPENAI_API_KEY are set.
 * This is the regression net for cutover-class bugs (like the DeepSeek
 * reasoning replay 400): mocks never catch wire/replay breakage, so the full
 * AgentSession pipeline runs against the live endpoint.
 */
const BASE_URL = process.env.LIVE_OPENAI_BASE_URL;
const API_KEY = process.env.LIVE_OPENAI_API_KEY;
const live = Boolean(BASE_URL && API_KEY);

const recordToolSchema = type({ value: type("string") });

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

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("moxuna", API_KEY ?? "no-live-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

function liveModel(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		provider: "moxuna",
		id: "deepseek-v4-pro",
		baseUrl: BASE_URL!,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
	});
}

function assistants(messages: AgentMessage[]): Array<Extract<AgentMessage, { role: "assistant" }>> {
	return messages.filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant");
}

describe.skipIf(!live)("live AgentSession end-to-end", () => {
	it("runs a tool turn and a follow-up without wire errors, persisting signed thinking", async () => {
		const tempDir = TempDir.createSync("@pi-live-agent-session-");
		const model = liveModel();
		vi.spyOn(sharedModelRegistry, "getAvailable").mockImplementation(kind => (kind === "all" ? [model] : []));

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			model: `${model.provider}/${model.id}`,
		});

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const tools = [recordTool as AgentTool];
		const agent = new Agent({
			getApiKey: () => API_KEY!,
			initialState: {
				model,
				systemPrompt: ["You are a live-integration test assistant. Call the record tool when asked."],
				tools,
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => undefined,
			streamFn: (streamModel, context, options) =>
				streamOpenAICompletions(streamModel as Model<"openai-completions">, context, {
					...options,
					apiKey: API_KEY!,
				}),
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});

		try {
			await session.prompt("Use the record tool to record the value 'live-session'. Call the tool now.");
			await session.waitForIdle();

			const turn1 = assistants(session.agent.state.messages)[0];
			expect(turn1).toBeTruthy();
			expect(turn1!.stopReason).toBe("toolUse");
			expect(turn1!.content).toContainEqual(
				expect.objectContaining({ type: "toolCall", name: "record" }),
			);
			// Reasoning model: the signed thinking block must be stored for replay.
			const thinking = turn1!.content.filter(block => block.type === "thinking");
			expect(thinking.length).toBeGreaterThan(0);
			expect(thinking[0]!.thinkingSignature).toBe("reasoning_content");

			await session.prompt("Now tell me what value was recorded.");
			await session.waitForIdle();

			const stored = assistants(session.agent.state.messages);
			expect(stored.length).toBeGreaterThanOrEqual(2);
			expect(stored.some(m => m.stopReason === "error")).toBe(false);
			// The final turn answered (no 400-class wire failure aborted it).
			const finalText = stored[stored.length - 1]!.content
				.map(block => (block.type === "text" ? block.text : ""))
				.join(" ");
			expect(finalText.toLowerCase()).toContain("live-session");

			// LLM view must retain the signed thinking for the encoder replay.
			const llm = convertToLlm(session.agent.state.messages);
			expect(
				llm.some(
					m =>
						m.role === "assistant" &&
						Array.isArray(m.content) &&
						m.content.some(
							block =>
								block.type === "thinking" &&
								"thinkingSignature" in block &&
								block.thinkingSignature === "reasoning_content",
						),
				),
			).toBe(true);
		} finally {
			vi.restoreAllMocks();
			await session.dispose();
			tempDir.removeSync();
		}
	}, 300_000);
});
