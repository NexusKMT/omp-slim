/**
 * Regression: an image whose bytes cannot be decoded makes the provider reject
 * the WHOLE request, not just the offending block, so a single corrupt payload
 * in history leaves a session permanently unable to send anything. The outbound
 * guard must degrade exactly that block to text and leave everything else —
 * including images with unusual-but-decodable framing, and images whose bytes
 * never travel because a reference does — byte-identical.
 */
import { describe, expect, test } from "bun:test";
import type { Context, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { dropUnreadableContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

/**
 * 1x1 PNG whose chunk framing does not land exactly on `IEND`, yet every
 * decoder (and every vision backend) accepts it. Pins the guard against a
 * structural walk that would reject payloads providers happily read.
 */
const ODD_FRAMED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/**
 * The incident shape: a base64 payload that was middle-elided before being
 * written to disk, so the signature, the header and the `IEND` trailer all
 * survive while the compressed stream has a hole in it.
 */
const MIDDLE_ELIDED_PNG = (() => {
	const whole = Buffer.from(ODD_FRAMED_PNG, "base64");
	return Buffer.concat([whole.subarray(0, 20), whole.subarray(40)]).toString("base64");
})();

const INTACT_IMAGE: ImageContent = { type: "image", data: ODD_FRAMED_PNG, mimeType: "image/png" };
const BROKEN_IMAGE: ImageContent = { type: "image", data: MIDDLE_ELIDED_PNG, mimeType: "image/png" };
function userMessage(content: (TextContent | ImageContent)[]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function toolResult(content: (TextContent | ImageContent)[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content,
		isError: false,
		timestamp: 0,
	} satisfies ToolResultMessage;
}

function textOf(part: TextContent | ImageContent | undefined): string {
	if (part?.type !== "text") throw new Error(`expected a text block, got ${part?.type}`);
	return part.text;
}

describe("dropUnreadableContextImages", () => {
	test("degrades an undecodable image to text and keeps decodable siblings byte-identical", async () => {
		const context: Context = {
			messages: [
				userMessage([INTACT_IMAGE]),
				toolResult([{ type: "text", text: "Read image file [image/png]" }, BROKEN_IMAGE, INTACT_IMAGE]),
			],
		};

		const guarded = await dropUnreadableContextImages(context);

		const guardedResult = guarded.messages[1];
		if (guardedResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(guardedResult.content[0]).toEqual({ type: "text", text: "Read image file [image/png]" });
		expect(textOf(guardedResult.content[1])).toContain("image omitted");
		expect(guardedResult.content[2]).toEqual(INTACT_IMAGE);
		// The user turn carried only the decodable image, so it is untouched.
		expect(guarded.messages[0]).toBe(context.messages[0]);
	});

	test("degrades a JPEG truncated before its EOI marker", async () => {
		// The incident: a download cut mid-scan. Bun.Image pads the missing rows
		// and decodes it, while the provider's strict decoder rejects the bytes
		// and fails the whole request — the guard must degrade it instead.
		const intact = Buffer.from(await new Bun.Image(Buffer.from(ODD_FRAMED_PNG, "base64")).jpeg().bytes());
		const truncated: ImageContent = {
			type: "image",
			data: intact.subarray(0, intact.length - 8).toString("base64"),
			mimeType: "image/jpeg",
		};
		const context: Context = { messages: [userMessage([truncated])] };

		const guarded = await dropUnreadableContextImages(context);
		const message = guarded.messages[0];
		if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(textOf(message.content[0])).toContain("truncated JPEG data");
	});

	test("returns the original context when every image decodes", async () => {
		const context: Context = { messages: [userMessage([{ type: "text", text: "look" }, INTACT_IMAGE])] };

		expect(await dropUnreadableContextImages(context)).toBe(context);
	});

	test("degrades empty inline data", async () => {
		const context: Context = { messages: [userMessage([{ type: "image", data: "", mimeType: "image/png" }])] };
		const guarded = await dropUnreadableContextImages(context);
		const message = guarded.messages[0];
		if (message.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(textOf(message.content[0])).toContain("empty image data");
	});

	test("degrades malformed base64 and bytes that do not match the declared container", async () => {
		const malformedBase64: ImageContent = {
			...INTACT_IMAGE,
			data: `${ODD_FRAMED_PNG.slice(0, 20)}!${ODD_FRAMED_PNG.slice(20)}`,
		};
		const mislabeled: ImageContent = { ...INTACT_IMAGE, mimeType: "image/jpeg" };
		const context: Context = { messages: [userMessage([malformedBase64, mislabeled])] };

		const guarded = await dropUnreadableContextImages(context);
		const message = guarded.messages[0];
		if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(textOf(message.content[0])).toContain("invalid base64");
		expect(textOf(message.content[1])).toContain("contains image/png");
	});

	test("leaves URL-backed images byte-identical without decoding their unused data", async () => {
		const urlBacked: ImageContent = { ...BROKEN_IMAGE, url: "https://images.example/frame.png" };
		const placeholder: ImageContent = { ...urlBacked, data: "" };
		const context: Context = { messages: [userMessage([urlBacked, placeholder]), toolResult([placeholder])] };
		expect(await dropUnreadableContextImages(context)).toBe(context);
	});
	test("decodes actual data URLs and leaves saved history untouched", async () => {
		const good = { ...BROKEN_IMAGE, url: `DATA:image/png;base64,${ODD_FRAMED_PNG}` };
		const bad = { ...INTACT_IMAGE, url: `data:image/png;base64,${MIDDLE_ELIDED_PNG}` };
		const context: Context = { messages: [userMessage([good, bad])] };
		const guarded = await dropUnreadableContextImages(context);
		const message = guarded.messages[0];
		if (message.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(message.content[0]).toBe(good);
		expect(textOf(message.content[1])).toContain("image omitted");
		expect(context.messages[0].content).toEqual([good, bad]);
	});
	test("degrades empty or malformed data URLs instead of throwing", async () => {
		for (const url of [
			"data:image/png;base64,",
			"data:image/png",
			"data:image/png,%GG",
			"data:image/png;base64,@@@!",
		]) {
			const context: Context = { messages: [userMessage([{ ...INTACT_IMAGE, url }])] };
			const guarded = await dropUnreadableContextImages(context);
			const message = guarded.messages[0];
			if (message.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
			expect(textOf(message.content[0])).toContain("image omitted");
		}
	});
	test("accepts percent-encoded binary image data URLs", async () => {
		const bytes = Buffer.from(ODD_FRAMED_PNG, "base64");
		const url = `data:image/png,${Array.from(bytes, value => `%${value.toString(16).padStart(2, "0")}`).join("")}`;
		const context: Context = { messages: [userMessage([{ ...BROKEN_IMAGE, url }])] };
		expect(await dropUnreadableContextImages(context)).toBe(context);
	});
});
