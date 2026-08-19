import { describe, expect, test } from "bun:test";
import { Encoding } from "@oh-my-pi/pi-natives";
import { claudeEncodingForModel, Tokenizer } from "../src/tokenizer";

// Contract: local token counting must pick the ctok family that matches the
// model's tokenizer generation (v3 for Claude 3 … Opus 4.6 and every
// non-opus < 5, v4.7 for Opus 4.7–4.9, v5 for the 5-series). A wrong family
// silently skews every context-budget and compaction decision for that model.
describe("claudeEncodingForModel", () => {
	test("opus routes on the 4.7 and 5.0 version thresholds", () => {
		expect(claudeEncodingForModel("claude-opus-4-5")).toBe(Encoding.ClaudeV3);
		expect(claudeEncodingForModel("claude-opus-4-6")).toBe(Encoding.ClaudeV3);
		expect(claudeEncodingForModel("claude-opus-4-7")).toBe(Encoding.ClaudeV47);
		expect(claudeEncodingForModel("claude-opus-4-9-20260101")).toBe(Encoding.ClaudeV47);
		expect(claudeEncodingForModel("claude-opus-5")).toBe(Encoding.ClaudeV5);
	});

	test("non-opus kinds skip the opus-only 4.7 family and use the sonnet-5 frame", () => {
		expect(claudeEncodingForModel("claude-sonnet-4-5-20250929")).toBe(Encoding.ClaudeV3);
		expect(claudeEncodingForModel("claude-sonnet-5")).toBe(Encoding.ClaudeV5Sonnet);
		expect(claudeEncodingForModel("claude-fable-5")).toBe(Encoding.ClaudeV5Sonnet);
	});
	test("unclassifiable claude ids fall back to v3; provider prefixes are stripped", () => {
		expect(claudeEncodingForModel("claude-3-5-haiku-20241022")).toBe(Encoding.ClaudeV3);
		expect(claudeEncodingForModel("claude-haiku-4-5")).toBe(Encoding.ClaudeV3);
		expect(claudeEncodingForModel("anthropic/claude-opus-4-7")).toBe(Encoding.ClaudeV47);
	});

	test("non-claude models get no ctok encoding", () => {
		expect(claudeEncodingForModel("gpt-5.4")).toBeNull();
		expect(claudeEncodingForModel("gemini-3-pro")).toBeNull();
		expect(claudeEncodingForModel("glm-4.7")).toBeNull();
	});
});

describe("Tokenizer", () => {
	test("defaults to null encoding and byte estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.encoding).toBeNull();
		expect(tokenizer.countTokens("hello world")).toBe(3);
	});

	test("encoding is fixed at construction per model id", () => {
		expect(new Tokenizer("claude-opus-4-7").encoding).toBe(Encoding.ClaudeV47);
		expect(new Tokenizer("claude-opus-5").encoding).toBe(Encoding.ClaudeV5);
		expect(new Tokenizer("gpt-5.4").encoding).toBeNull();
		expect(new Tokenizer(undefined).encoding).toBeNull();
	});

	test("separate instances do not interfere with each other", () => {
		const t1 = new Tokenizer("claude-opus-4-7");
		const t2 = new Tokenizer("claude-opus-5");
		const t3 = new Tokenizer("gpt-5.4");

		expect(t1.encoding).toBe(Encoding.ClaudeV47);
		expect(t2.encoding).toBe(Encoding.ClaudeV5);
		expect(t3.encoding).toBeNull();

		const t4 = new Tokenizer("claude-sonnet-4-5-20250929");
		expect(t4.encoding).toBe(Encoding.ClaudeV3);
		expect(t1.encoding).toBe(Encoding.ClaudeV47);
		expect(t2.encoding).toBe(Encoding.ClaudeV5);
		expect(t3.encoding).toBeNull();
	});
});

describe("countTokens with modes", () => {
	test("approximate mode uses fast estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "approximate")).toBe(3);
	});

	test("upperbound mode uses byte length", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
	});

	test("strict mode uses native counting regardless of encoding", () => {
		const noEncoding = new Tokenizer();
		expect(noEncoding.countTokens("hello world", "strict")).toBe(2);

		const claudeEncoding = new Tokenizer("claude-opus-4-7");
		expect(claudeEncoding.countTokens("hello world", "strict")).toBeGreaterThan(0);
	});

	test("mode is per-call; encoding stays independently model-scoped in strict mode", () => {
		// approximate/upperbound skip the encoding entirely under NODE_ENV=test
		// (fast estimate for a snappy suite); strict is testEnv-independent, so
		// it is the mode that proves per-instance encoding isolation here.
		const claude = new Tokenizer("claude-opus-4-7");
		const generic = new Tokenizer("gpt-5.4");
		expect(claude.countTokens("hello world", "strict")).not.toBe(generic.countTokens("hello world", "strict"));
	});
});
