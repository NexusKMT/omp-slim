// Contract: an ImageContent carrying `url` ships the URL to providers whose
// APIs fetch remote images — and its base64 payload stays off the wire.
// Undecorated blocks keep the inline base64 forms byte-for-byte.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Message, Model, ProviderFileReference, UserMessage } from "@oh-my-pi/pi-ai/types";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";

const PNG_B64 = Buffer.from("not-actually-a-png, but bytes are opaque here").toString("base64");
const BLOB_URL = "https://blobs.example.com/0123456789abcdef0123456789abcdef.png";
const userMessage: Message = {
	role: "user",
	content: [
		{ type: "text", text: "what is in these?" },
		{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL },
		{ type: "image", data: PNG_B64, mimeType: "image/png" },
	],
	timestamp: 0,
};

function withProviderFile(providerFile: ProviderFileReference): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what is in this?" },
			{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL, providerFile },
		],
		timestamp: 0,
	};
}

describe("image url parts", () => {
	it("completions sends the url in image_url content parts", async () => {
		const model = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		} satisfies Model<"openai-completions">;
		let captured: { messages?: Array<{ content: unknown }> } | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const sse =
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
				"data: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;

		const context: Context = { messages: [userMessage] };
		await streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchImpl }).result();

		const parts = captured?.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
		const images = parts.filter(part => part.type === "image_url");
		expect(images[0].image_url?.url).toBe(BLOB_URL);
		expect(images[1].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
	});
});
