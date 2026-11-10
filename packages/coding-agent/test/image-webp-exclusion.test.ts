import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	normalizeModelContextImages,
	normalizeModelContextMessages,
} from "@oh-my-pi/pi-coding-agent/utils/image-loading";

// 1x1 red PNG seed, upscaled + re-encoded as WebP at test time so no binary
// fixture is checked in. Bun.Image sniffs format from bytes.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedWebP(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed)
		.resize(width, height, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return Buffer.from(upscaled).toBase64();
}

describe("explicit WebP exclusion", () => {
	const prior = Bun.env.OMP_NO_WEBP;

	beforeEach(() => {
		delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
	});

	afterEach(() => {
		if (prior === undefined) delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
		else Bun.env.OMP_NO_WEBP = prior;
	});

	test("re-encodes WebP when explicitly excluded", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], { excludeWebP: true });
		expect(result).toHaveLength(1);
		const mime = result![0]!.mimeType;
		expect(mime).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(mime);
	});

	test("keeps WebP by default when OMP_NO_WEBP is unset", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], {});

		expect(result?.[0]?.mimeType).toBe("image/webp");
	});

	test("honors resize options when caching explicit image normalization", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(400, 400), mimeType: "image/webp" };

		const first = await normalizeModelContextImages([webp], {
			excludeWebP: true,
			resize: { maxWidth: 120, maxHeight: 120, minDimension: 1 },
		});
		const second = await normalizeModelContextImages([webp], {
			excludeWebP: true,
			resize: { maxWidth: 60, maxHeight: 60, minDimension: 1 },
		});
		const firstMetadata = await new Bun.Image(Buffer.from(first![0]!.data, "base64")).metadata();
		const secondMetadata = await new Bun.Image(Buffer.from(second![0]!.data, "base64")).metadata();

		expect(firstMetadata.width).toBe(120);
		expect(secondMetadata.width).toBe(60);
	});

	test("preserves an undecodable WebP attachment slot for provider-boundary omission", async () => {
		const corrupt = {
			type: "image" as const,
			data: Buffer.from("RIFF0000WEBPcorrupt").toBase64(),
			mimeType: "image/webp",
		};

		const result = await normalizeModelContextImages([corrupt], {
			excludeWebP: true,
		});

		expect(result).toEqual([corrupt]);
	});

	test("rewrites resumed tool-result WebP blocks when WebP is explicitly excluded", async () => {
		const original = {
			type: "image" as const,
			data: await makeRedWebP(200, 200),
			// Exercise byte sniffing as well as declared-MIME handling.
			mimeType: "image/png",
			detail: "original" as const,
		};
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text" as const, text: "screenshot" }, original],
				isError: false,
				timestamp: 1,
			},
		];

		const result = await normalizeModelContextMessages(messages, { excludeWebP: true });
		const resultMessage = result[0]!;
		expect(resultMessage.role).toBe("toolResult");
		if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");
		const image = resultMessage.content[1]!;

		expect(image.type).toBe("image");
		if (image.type !== "image") throw new Error("Expected normalized image block");
		expect(image.mimeType).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(image.mimeType);
		expect(Buffer.from(image.data.slice(0, 16), "base64").toString("ascii", 8, 12)).not.toBe("WEBP");
		expect(image.detail).toBe("original");
		// Provider-boundary normalization is ephemeral; persisted history is not mutated.
		expect(messages[0]!.content[1]).toBe(original);
	});

	test("honors the explicit environment switch for resumed images", async () => {
		const image = { type: "image" as const, mimeType: "image/webp", data: await makeRedWebP(40, 40) };
		const messages: Message[] = [{ role: "user", content: [image], timestamp: 0 }];
		Bun.env.OMP_NO_WEBP = "true";
		const rewritten = await normalizeModelContextMessages(messages);
		expect(JSON.stringify(rewritten)).not.toContain("image/webp");
		expect(messages[0]?.content).toEqual([image]);
		expect(await normalizeModelContextMessages(messages, { excludeWebP: false })).toBe(messages);
	});

	test("replaces an undecodable historical WebP with an omission note", async () => {
		const corrupt = {
			type: "image" as const,
			data: Buffer.from("RIFF0000WEBPbad-history").toBase64(),
			mimeType: "image/webp",
		};
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "read-corrupt",
				toolName: "read",
				content: [corrupt],
				isError: false,
				timestamp: 1,
			},
		];

		const result = await normalizeModelContextMessages(messages, { excludeWebP: true });
		const resultMessage = result[0]!;
		expect(resultMessage.role).toBe("toolResult");
		if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");

		expect(resultMessage.content).toEqual([
			{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
		]);
		expect(messages[0]!.content[0]).toBe(corrupt);
	});

	test("normalizes persisted WebP blocks with malformed MIME metadata", async () => {
		for (const mimeType of [undefined, null, 42]) {
			const malformedImage = {
				type: "image",
				data: Buffer.from("RIFF0000WEBPbad-persisted-image").toBase64(),
				...(mimeType === undefined ? {} : { mimeType }),
			};
			const messages = [
				{
					role: "toolResult",
					toolCallId: "read-malformed",
					toolName: "read",
					content: [malformedImage],
					isError: false,
					timestamp: 1,
				},
			] as unknown as Message[];

			const result = await normalizeModelContextMessages(messages, { excludeWebP: true });
			const resultMessage = result[0]!;
			expect(resultMessage.role).toBe("toolResult");
			if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");
			expect(resultMessage.content).toEqual([
				{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
			]);
		}
	});

	test("does not throw on persisted image blocks with malformed data", async () => {
		for (const data of [undefined, null, 42]) {
			const malformedImage = {
				type: "image",
				mimeType: "image/webp",
				...(data === undefined ? {} : { data }),
			};
			const messages = [
				{
					role: "toolResult",
					toolCallId: "read-malformed-data",
					toolName: "read",
					content: [malformedImage],
					isError: false,
					timestamp: 1,
				},
			] as unknown as Message[];

			const result = await normalizeModelContextMessages(messages, { excludeWebP: true });
			expect(result).toBe(messages);
			expect((result[0]!.content as unknown[])[0]).toBe(malformedImage);
		}
	});
});
