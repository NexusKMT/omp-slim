import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@oh-my-pi/pi-agent-core/compaction";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// User-selected effort must reach the handoff and every summary in a split turn.
// No provider identity may override the explicit model's reasoning capabilities.

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "openai-completions",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getModel(): Model {
	return buildModel({
		id: "configured-model",
		provider: "gateway",
		baseUrl: "http://localhost:0/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [ai.Effort.Low, ai.Effort.Medium, ai.Effort.High] },
	});
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage([{ type: "text", text: "started" }]),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction thinking-level resolution (regression)", () => {
	test("undefined thinkingLevel → reasoning=high (historical default preserved)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			// thinkingLevel omitted — must default to high
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});

	test("ThinkingLevel.Off → reasoning=undefined (user intent honored)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Off,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		// Codex-caught defect: Off MUST NOT be silently coerced to High.
		expect(call[2]?.reasoning).toBeUndefined();
	});

	test("ThinkingLevel.Low → reasoning=low (explicit user choice)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Low,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.Low);
	});

	test("ThinkingLevel.Inherit → reasoning=high (Inherit folds to historical default)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Inherit,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});
});

// ============================================================================
// compact() end-to-end regression coverage.
//
// The handoff tests above were the test vehicle e07b47ee4 used because handoff
// issues exactly one LLM call. They prove `resolveCompactionEffort` works at
// each call site in isolation. They do NOT prove `compact()` forwards
// `options.thinkingLevel` into the fan-out struct (`summaryOptions`) that
// reaches generateSummary / generateTurnPrefixSummary / generateShortSummary.
// That gap is what dropped the field at compaction.ts:963 and 1056 — every
// downstream summarizer saw `undefined` and fell back to Effort.High.
//
// These tests drive compact() with `isSplitTurn: true` so all three
// summarizers fire, then assert the captured `reasoning` on each
// `completeSimple` call. The contract is: every fan-out call receives the
// SAME resolved effort as a single handoff call would.
// ============================================================================

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			makeUserMessage("history msg"),
			createAssistantMessage([{ type: "text", text: "history reply" }]),
		],
		turnPrefixMessages: [makeUserMessage("turn prefix msg")],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: snapcompact.createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
		...overrides,
	};
}

describe("compact() propagates thinkingLevel to all three summarizers (regression)", () => {
	test("ThinkingLevel.Off → every fan-out call gets reasoning=undefined", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getModel(), "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.Off,
		});

		// Split-turn preparation fans out into history + turn-prefix + short.
		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBeUndefined();
		}
	});

	test("ThinkingLevel.Low → every fan-out call gets reasoning=low", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getModel(), "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBe(ai.Effort.Low);
		}
	});

	test("undefined thinkingLevel → every fan-out call still gets reasoning=high (historical default)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getModel(), "test-key", undefined, undefined);

		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBe(ai.Effort.High);
		}
	});
});
