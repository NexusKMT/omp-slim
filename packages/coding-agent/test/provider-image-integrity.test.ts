/**
 * Regression: an image whose bytes cannot be decoded makes the provider reject
 * the WHOLE request, not just the offending block, so a single corrupt payload
 * in history leaves a session permanently unable to send anything. The outbound
 * guard must degrade exactly that block to text and leave everything else —
 * including images with unusual-but-decodable framing — byte-identical.
 */
import { describe, expect, test } from "bun:test";
import type { Context, ImageContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
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
function middleElidedPng(): string {
	const whole = Buffer.from(ODD_FRAMED_PNG, "base64");
	return Buffer.concat([whole.subarray(0, 20), whole.subarray(40)]).toString("base64");
}

function userMessage(content: (ImageContent | { type: "text"; text: string })[]): UserMessage {
	return { role: "user", content, timestamp: 0 } as UserMessage;
}

describe("dropUnreadableContextImages", () => {
	test("degrades an undecodable image to text and keeps decodable siblings byte-identical", async () => {
		const broken: ImageContent = { type: "image", data: middleElidedPng(), mimeType: "image/png" };
		const intact: ImageContent = { type: "image", data: ODD_FRAMED_PNG, mimeType: "image/png" };
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "Read image file [image/png]" }, broken, intact],
			timestamp: 0,
		} as ToolResultMessage;
		const context: Context = { messages: [userMessage([intact]), toolResult] } as Context;

		const guarded = await dropUnreadableContextImages(context);

		const guardedResult = guarded.messages[1] as ToolResultMessage;
		expect(guardedResult.content[0]).toEqual({ type: "text", text: "Read image file [image/png]" });
		const omission = guardedResult.content[1];
		expect(omission.type).toBe("text");
		expect(omission.type === "text" ? omission.text : "").toContain("image omitted");
		expect(guardedResult.content[2]).toEqual(intact);
		// The user turn carried only the decodable image, so it is untouched.
		expect(guarded.messages[0]).toBe(context.messages[0]);
	});

	test("returns the original context when every image decodes", async () => {
		const intact: ImageContent = { type: "image", data: ODD_FRAMED_PNG, mimeType: "image/png" };
		const context: Context = { messages: [userMessage([{ type: "text", text: "look" }, intact])] } as Context;

		expect(await dropUnreadableContextImages(context)).toBe(context);
	});
});
