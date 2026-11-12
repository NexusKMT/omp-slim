import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool } from "@oh-my-pi/pi-ai";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const model = buildModel({
	id: "vision",
	provider: "custom",
	baseUrl: "https://chat.example/v1",
	input: ["text", "image"],
});
const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const text = (value: string): TextContent => ({ type: "text", text: value });
const user = (content: (TextContent | ImageContent)[]): Message => ({ role: "user", content, timestamp: 0 });
const tool = (content: (TextContent | ImageContent)[]): Message => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content,
	isError: false,
	timestamp: 0,
});
function images(context: Context): ImageContent[] {
	return context.messages.flatMap(message =>
		Array.isArray(message.content) ? (message.content.filter(part => part.type === "image") as ImageContent[]) : [],
	);
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("Chat image count budget", () => {
	it("drops oldest input images across roles while preserving text and saved history", () => {
		const context: Context = {
			messages: [
				user([text("keep"), image("a"), image("b")]),
				{ role: "developer", content: [image("c")], timestamp: 0 },
				tool([image("d"), image("e"), image("f")]),
			],
		};
		const result = clampProviderContextImages(context, model);
		expect(images(result).map(block => block.data)).toEqual(["b", "c", "d", "e", "f"]);
		expect(result.messages[0].content).toEqual([text("keep"), image("b")]);
		expect(images(context)).toHaveLength(6);
		expect(result.messages[2]).toBe(context.messages[2]);
	});
	it("keeps image-only messages meaningful and counts remote URLs", () => {
		const context: Context = {
			messages: [tool([image("a")]), user([{ ...image(""), url: "https://images.example/frame.png" }])],
		};
		const result = clampProviderContextImages(context, model, 1);
		expect(result.messages[0].content).toEqual([text("[image omitted: provider image limit]")]);
		expect(result.messages[1]).toBe(context.messages[1]);
	});
	it("does not charge assistant output images", () => {
		const context: Context = { messages: [assistant([image("output")]), user([image("input")])] };
		expect(clampProviderContextImages(context, model, 1)).toBe(context);
	});
	it("preserves identity inside the cap and bypasses text-only endpoints", () => {
		const context: Context = { messages: [user([image("a"), image("b")])] };
		expect(clampProviderContextImages(context, model)).toBe(context);
		expect(clampProviderContextImages(context, { ...model, input: ["text"] }, 0)).toBe(context);
	});
});

describe("Chat image byte budget", () => {
	it("allows the exact inline boundary then drops the oldest frame immutably", () => {
		const context: Context = { messages: [user([image("A".repeat(1000))]), tool([image("B".repeat(1000))])] };
		expect(clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 2000 })).toBe(context);
		const result = clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 1999 });
		expect(images(result).map(block => block.data[0])).toEqual(["B"]);
		expect(images(context)).toHaveLength(2);
	});
	it("omits oversized image-only turns while keeping their role and position", () => {
		const context: Context = { messages: [user([image("A".repeat(1001))]), tool([image("B".repeat(1001))])] };
		const result = clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 1000 });
		expect(images(result)).toHaveLength(0);
		expect(result.messages.map(message => message.role)).toEqual(["user", "toolResult"]);
		for (const message of result.messages)
			expect(message.content).toEqual([text("[image omitted: provider image limit]")]);
	});
	it("protects the newest user image when older archived frames must be evicted", () => {
		const context: Context = {
			messages: [
				{ ...user([image("A".repeat(1000))]), historyRewriteAt: 1 } as Message,
				tool([image("B".repeat(1000))]),
				user([image("C".repeat(1500))]),
			],
		};
		const result = clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 2000 });
		expect(images(result).map(block => block.data[0])).toEqual(["C"]);
		expect(result.messages[2]).toBe(context.messages[2]);
	});
	it("does not charge remote URLs or assistant outputs as inline data", () => {
		const remote = { ...image("A".repeat(10000)), url: "https://images.example/frame.png" };
		const context: Context = {
			messages: [assistant([image("B".repeat(10000))]), user([remote, image("C".repeat(100))])],
		};
		expect(clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 100 })).toBe(context);
	});
	it("retains older URL images when later inline bytes exceed the budget", () => {
		const remote = { ...image(""), url: "https://images.example/frame.png" };
		const context: Context = { messages: [user([remote]), tool([image("A".repeat(2000))])] };
		expect(images(clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 1000 }))).toEqual([remote]);
	});
	it("charges inline data URLs even with an upper-case scheme", () => {
		const context: Context = {
			messages: [user([{ ...image(""), url: `DATA:image/png;base64,${"A".repeat(1000)}` }])],
		};
		expect(images(clampProviderContextImageBytes(context, model, { maxInlineImageBytes: 999 }))).toHaveLength(0);
	});
	it("reserves UTF-8 text and the request envelope before protecting fresh images", () => {
		const context: Context = { messages: [user([text("界".repeat(10000)), image("A".repeat(15000))])] };
		const result = clampProviderContextImageBytes(context, model, { maxRequestBytes: 100000 });
		expect(images(result)).toHaveLength(0);
		expect(JSON.stringify(buildParams(model, result))).toContain("界");
	});
	it("counts escaped tool arguments as they actually appear in the Chat body", () => {
		const call = assistant([
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: '\\"'.repeat(10000) } },
		]);
		const context: Context = { messages: [call, tool([image("A".repeat(5000))])] };
		const result = clampProviderContextImageBytes(context, model, { maxRequestBytes: 145000 });
		expect(images(result)).toHaveLength(0);
		expect(Buffer.byteLength(JSON.stringify(buildParams(model, result)))).toBeLessThan(145000);
	});
	it("counts tool declarations but excludes their runtime state and UI result details", () => {
		const liveTool = {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: {} },
			runtimeState: "x".repeat(1000000),
		} as unknown as Tool;
		const context: Context = {
			tools: [liveTool],
			messages: [{ ...tool([image("A".repeat(5000))]), details: { preview: "x".repeat(1000000) } } as Message],
		};
		expect(clampProviderContextImageBytes(context, model, { maxRequestBytes: 100000 })).toBe(context);
		const schemaHeavy = { ...context, tools: [{ ...liveTool, description: "x".repeat(50000) }] };
		expect(images(clampProviderContextImageBytes(schemaHeavy, model, { maxRequestBytes: 100000 }))).toHaveLength(0);
	});
	it("uses the same defaults for every custom endpoint and bypasses text-only models", () => {
		const context: Context = { messages: [user([image("A".repeat(7000000))])] };
		expect(images(clampProviderContextImageBytes(context, model))).toHaveLength(0);
		expect(
			images(
				clampProviderContextImageBytes(context, {
					...model,
					provider: "other",
					baseUrl: "http://localhost:8080/v1",
				}),
			),
		).toHaveLength(0);
		expect(clampProviderContextImageBytes(context, { ...model, input: ["text"] })).toBe(context);
	});
});

describe("archive frame budget", () => {
	it("caps only archived summary frames and preserves surrounding text and live images", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						text("summary"),
						image("A".repeat(1000)),
						image("B".repeat(1000)),
						image("C".repeat(1000)),
						text("tail"),
					],
					historyRewriteAt: 1,
					timestamp: 0,
				},
				user([image("D".repeat(2000))]),
			],
		};
		const result = capArchiveFrameBytes(context, 1500);
		expect(images(result).map(block => block.data[0])).toEqual(["C", "D"]);
		expect(result.messages[1]).toBe(context.messages[1]);
		expect(JSON.stringify(result.messages[0])).toContain("2 archived image frames could not be included");
		expect(images(context)).toHaveLength(4);
		expect(capArchiveFrameBytes(context, 3000)).toBe(context);
	});
});
