import { describe, expect, it } from "bun:test";
import { handleHuggingFace } from "@oh-my-pi/pi-coding-agent/web/scrapers/huggingface";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleHuggingFace", () => {
	it("returns null for non-HF URLs", async () => {
		const result = await handleHuggingFace("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid HF URLs", async () => {
		const result = await handleHuggingFace("https://huggingface.co", 10);
		expect(result).toBeNull();
	});

	it("fetches model info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/bert-base-uncased", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("bert-base-uncased");
	});

	it("fetches dataset info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/datasets/squad", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("squad");
	});

	it("fetches space info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/spaces/gradio/hello_world", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("gradio/hello_world");
	});

	it("handles org/model format", async () => {
		const result = await handleHuggingFace("https://huggingface.co/google/bert_uncased_L-2_H-128_A-2", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("google/bert_uncased_L-2_H-128_A-2");
	});
});
