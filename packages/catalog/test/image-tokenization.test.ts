import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	DEFAULT_OPENAI_PATCH_TOKENIZATION,
	type ImageTokenization,
	imageTokens,
	resolveImageTokenization,
} from "@oh-my-pi/pi-catalog/compat/image-tokenization";

const HIRES: ImageTokenization = { regime: "anthropic-patch", maxEdge: 2576, maxTokens: 4784 };
const STANDARD: ImageTokenization = { regime: "anthropic-patch", maxEdge: 1568, maxTokens: 1568 };
const GPT_PATCH = DEFAULT_OPENAI_PATCH_TOKENIZATION;

function ruleFor(provider: string, id: string): ImageTokenization {
	const rule = resolveImageTokenization({ provider, id });
	if (!rule) throw new Error(`no image rule for ${provider}/${id}`);
	return rule;
}

describe("resolveImageTokenization", () => {
	it("splits Claude at 4.7: Opus 4.6 and older on the standard tier, 4.7+ and Fable/Mythos high-res", () => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-5-sonnet-20241022"]) {
			expect(resolveImageTokenization({ provider: "anthropic", id })).toEqual(STANDARD);
		}
		for (const id of [
			"claude-opus-4-7",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-fable-5-1",
			"claude-fable-latest",
			"claude-mythos-preview",
		]) {
			expect(resolveImageTokenization({ provider: "anthropic", id })).toEqual(HIRES);
		}
		// Separator-collapsed `claude-opus-45` is Opus 4.5, not revision 45.
		expect(resolveImageTokenization({ provider: "anthropic", id: "claude-opus-45" })).toEqual(STANDARD);
	});

	it("follows the Claude lineage through gateways and cloud hosts", () => {
		expect(
			resolveImageTokenization({
				provider: "openrouter",
				api: "openai-completions",
				id: "anthropic/claude-opus-4.7",
			}),
		).toEqual(HIRES);
		expect(
			resolveImageTokenization({
				provider: "openrouter",
				api: "openai-completions",
				id: "anthropic/claude-sonnet-4.6",
			}),
		).toEqual(STANDARD);
		expect(
			resolveImageTokenization({
				provider: "amazon-bedrock",
				api: "bedrock-converse-stream",
				id: "us.anthropic.claude-opus-4-7-v1:0",
			}),
		).toEqual(HIRES);
		expect(
			resolveImageTokenization({ provider: "google-vertex", api: "google-vertex", id: "claude-fable-5@20250929" }),
		).toEqual(HIRES);
	});

	it("prices every current Codex model with 32px patches × 1.2", () => {
		for (const id of [
			"gpt-6-astra",
			"gpt-6.1-sol",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-daybreak-blue-latest",
			"gpt-5.3-codex",
		]) {
			const rule = ruleFor("openai-codex", id);
			expect(rule).toMatchObject({ regime: "openai-patch", multiplier: 1.2 });
			expect(imageTokens(rule, { width: 1568, height: 1562 }, "original")).toBe(2882);
		}
	});

	it("sizes each detail level the way the guide lists for that model", () => {
		const astra = ruleFor("openai", "gpt-6-astra");
		// Guide example: astra `high` keeps a 4096×512 image (65,535px limit).
		expect(imageTokens(astra, { width: 4096, height: 512 }, "high")).toBe(2458);
		// Astra `original` has no resizing budget; gpt-5.5 caps at 10,000 patches.
		expect(imageTokens(astra, { width: 4096, height: 4096 }, "original")).toBe(19_661);
		expect(imageTokens(ruleFor("openai", "gpt-5.5"), { width: 4096, height: 4096 }, "original")).toBe(12_000);
		// gpt-5.6 `high` fits 2048px first.
		expect(imageTokens(ruleFor("openai", "gpt-5.6-sol"), { width: 4096, height: 512 }, "high")).toBe(615);
		// gpt-5.4 sizes `auto` like `high` (2,500 patches).
		const gpt54 = ruleFor("openai", "gpt-5.4-mini");
		expect(imageTokens(gpt54, { width: 1932, height: 1920 })).toBe(2940);
		expect(imageTokens(gpt54, { width: 1932, height: 1920 }, "original")).toBe(4392);
	});

	it("bills Gemini 3 a fixed budget and leaves unruled lines to the caller", () => {
		expect(resolveImageTokenization({ provider: "google", id: "gemini-3.5-flash" })).toEqual({
			regime: "fixed",
			tokens: 1120,
		});
		expect(resolveImageTokenization({ provider: "google", id: "gemini-2.5-pro" })).toBeUndefined();
		expect(resolveImageTokenization({ provider: "openrouter", id: "moonshotai/kimi-k2.6" })).toBeUndefined();
		for (const id of ["gpt-5.1-codex-max", "gpt-5.1", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o3"]) {
			expect(resolveImageTokenization({ provider: "openai", id })).toBeUndefined();
		}
	});

	it("uses a built model's identity", () => {
		const model = buildModel({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		expect(resolveImageTokenization(model)).toEqual(STANDARD);
		expect(resolveImageTokenization({ ...model, identity: { ...model.identity, revision: "4.7.0" } })).toEqual(HIRES);
	});
});

describe("imageTokens", () => {
	it("matches the per-frame input-token deltas measured on live requests", () => {
		expect(imageTokens(GPT_PATCH, { width: 1568, height: 1562 }, "original")).toBe(2882);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "original")).toBe(4392);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "auto")).toBe(4392);
		// `high` resizes to a 2,500-patch budget; `low` fits 512px.
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "high")).toBe(2940);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "low")).toBe(308);
		expect(imageTokens(HIRES, { width: 1932, height: 1920 })).toBe(4761);
		// The standard tier shrinks to the largest size under its 1,568-token cap.
		expect(imageTokens(STANDARD, { width: 1932, height: 1920 })).toBe(40 * 39);
		expect(imageTokens(STANDARD, { width: 1568, height: 1568 })).toBe(39 * 39);
	});

	it("follows OpenAI's documented patch examples", () => {
		expect(imageTokens(GPT_PATCH, { width: 1024, height: 1024 }, "high")).toBe(1229);
		expect(imageTokens(GPT_PATCH, { width: 2048, height: 2048 }, "high")).toBe(3000);
		expect(imageTokens(GPT_PATCH, { width: 4096, height: 512 }, "original")).toBe(2458);
	});

	it("resizes Anthropic images like the reference implementation", () => {
		expect(imageTokens(HIRES, { width: 200, height: 100 })).toBe(8 * 4);
		expect(imageTokens(HIRES, { width: 4000, height: 4000 })).toBe(69 * 69);
		// Guide examples on the standard tier: A4 scan 1075×1520 → 924×1307,
		// 1920×1080 screenshot → 1456×819.
		expect(imageTokens(STANDARD, { width: 1075, height: 1520 })).toBe(33 * 47);
		expect(imageTokens(STANDARD, { width: 1920, height: 1080 })).toBe(52 * 30);
		// Near-square: the short edge follows the original aspect, so 3000×2999
		// lands at 1092×1092 (39²), not 40·39.
		expect(imageTokens(STANDARD, { width: 3000, height: 2999 })).toBe(39 * 39);
		expect(imageTokens(STANDARD, { width: 2999, height: 3000 })).toBe(39 * 39);
		expect(imageTokens({ regime: "fixed", tokens: 1120 }, { width: 2048, height: 2048 })).toBe(1120);
	});
});
