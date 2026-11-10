import { expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { base64ImageSize, estimateImageTokens } from "@oh-my-pi/pi-agent-core/image-tokens";

test("counts unreadable image data without treating it as free context", () => {
	const tokenizer = new Tokenizer();
	const image = { type: "image" as const, data: "malformed", mimeType: "image/png" };
	expect(base64ImageSize(image.data)).toBeNull();
	expect(tokenizer.countMessage({ role: "user", content: [image], timestamp: 0 })).toBe(estimateImageTokens(null));
	expect(tokenizer.countMessage({ role: "user", content: [{ ...image, detail: "low" }], timestamp: 0 })).toBeLessThan(
		estimateImageTokens(null),
	);
});
