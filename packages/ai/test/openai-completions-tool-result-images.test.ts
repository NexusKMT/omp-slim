import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png", detail: "original" },
		],
		isError: false,
		timestamp,
	};
}

describe("openai-completions convertMessages", () => {
	it("serializes image inputs as Chat Completions data URIs", () => {
		const model = buildModel({
			id: "gemma-4-31b",
			name: "Gemma 4 31B",
			api: "openai-completions",
			provider: "cerebras",
			baseUrl: "https://api.cerebras.ai/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Identify the shapes and colors. Return JSON only." },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
			],
		};

		const messages = convertMessages(model, context);

		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Identify the shapes and colors. Return JSON only." },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,ZmFrZQ==" },
					},
				],
			},
		]);
	});

	it("batches tool-result images without unsupported original-detail metadata", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context);
		const roles = messages.map(message => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (
			imageMessage.content as Array<{ type?: string; image_url?: { url: string; detail?: string } }>
		).filter(part => part?.type === "image_url");
		expect(imageParts).toEqual([
			{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==", detail: "high" } },
			{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==", detail: "high" } },
		]);
	});
	it("omits visible content for a tool-only assistant turn", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Read missing file", timestamp: now - 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "missing.txt" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: now,
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: now + 1,
				},
			],
		};

		const messages = convertMessages(model, context);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; content: unknown; tool_calls?: Array<{ id: string }> }
			| undefined;

		expect(assistantParam?.tool_calls).toHaveLength(1);
		expect(assistantParam?.content).toBeNull();
	});

	it("serializes string tool arguments into valid JSON objects", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "read",
					arguments: '{"path":"README.md"}' as unknown as Record<string, unknown>,
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [{ role: "user", content: "Read README", timestamp: now - 1 }, assistantMessage],
		};

		const messages = convertMessages(model, context);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> }
			| undefined;
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.tool_calls).toBeDefined();
		const serializedArgs = assistantParam!.tool_calls![0].function.arguments;
		expect(JSON.parse(serializedArgs)).toEqual({ path: "README.md" });
	});
});
