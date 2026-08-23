import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isContextOverflow, isPayloadRejection } from "@oh-my-pi/pi-ai/error";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow - model_context_window_exceeded", () => {
	it("detects model_context_window_exceeded in finish_reason error message", () => {
		const message = createErrorMessage("Provider finish_reason: model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects raw model_context_window_exceeded in error message", () => {
		const message = createErrorMessage("model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});
	it("detects empty Ollama length completion guidance", () => {
		const message = createErrorMessage(
			"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.",
		);
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow/isPayloadRejection - HTTP 413 variants", () => {
	it("classifies byte/media-driven 413s as payload rejection, not overflow (#9235)", () => {
		const message = createErrorMessage("413 Request Entity Too Large: payload too large for request body");
		expect(isContextOverflow(message)).toBe(false);
		expect(isPayloadRejection(message)).toBe(true);
	});

	it("classifies ninfer-style param=request_too_large bodies as payload rejection (#9235)", () => {
		const message = createErrorMessage(
			"413 request body exceeds the configured payload limit (type=invalid_request_error param=request_too_large)",
		);
		expect(isContextOverflow(message)).toBe(false);
		expect(isPayloadRejection(message)).toBe(true);
	});

	it("keeps media-budget numeric limits carrying a payload flag (#9235 review)", () => {
		// `request_too_large` plus a bare numeric limit is the media-budget
		// shape ("image count exceeds the limit of 20"). The generic limit
		// pattern must not veto the payload flag, or sessions run token
		// compaction that cannot shrink a vision-media budget.
		const message = createErrorMessage("request_too_large: image count exceeds the limit of 20");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(true);
	});

	it("keeps plain numeric-limit bodies without payload phrases classified as overflow", () => {
		const message = createErrorMessage("input exceeds the limit of 200000");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});

	it("keeps request_too_large carrying token-count evidence classified as overflow", () => {
		const message = createErrorMessage("request_too_large: prompt is too long: 300000 tokens > 200000 maximum");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});

	it("keeps request_too_large with evidence-BEFORE token counts classified as overflow", () => {
		const message = createErrorMessage("300000 tokens exceeds the context window: request_too_large");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});

	it("keeps other payload phrases with token-count evidence classified as overflow", () => {
		const message = createErrorMessage("413 Payload too large: maximum context length is 100 tokens");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});

	it("keeps entity-too-large with token limit digits classified as overflow", () => {
		const message = createErrorMessage("entity too large: exceeds the limit of 200000 tokens");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});

	it("flags Anthropic 'maximum size' wording as payload rejection", () => {
		const message = createErrorMessage("Request exceeds the maximum size allowed by this model");
		expect(isPayloadRejection(message)).toBe(true);
	});

	it("does not classify unrelated 413 errors as overflow or payload rejection", () => {
		const message = createErrorMessage("413 Forbidden");
		expect(isContextOverflow(message)).toBe(false);
		expect(isPayloadRejection(message)).toBe(false);
	});
});
describe("isContextOverflow - 400/413 no-body (Cerebras, Mistral, proxy wrappers)", () => {
	it("detects bare '400 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("400 status code (no body)"))).toBe(true);
	});

	it("detects bare '413 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("413 status code (no body)"))).toBe(true);
	});

	it("detects '400 (no body)' without 'status code' word", () => {
		expect(isContextOverflow(createErrorMessage("400 (no body)"))).toBe(true);
	});

	// Regression: api.synthetic.new wraps upstream HF 400-no-body in a JSON envelope.
	// finalizeErrorMessage transforms the response to "400 status code: {JSON}" where
	// the JSON value contains the inner "400 status code (no body)" text.
	it('detects wrapped proxy envelope: \'400 status code: {"error":"... 400 status code (no body)"}\'', () => {
		const errorMessage = '400 status code: {"error":"Error from inference backend: 400 status code (no body)"}';
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("detects when status code phrase is embedded deeper in the message", () => {
		const errorMessage = "Upstream rejected request: 400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("does not classify unrelated 400 errors as overflow", () => {
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("does not classify 429 (rate limit) as overflow", () => {
		expect(isContextOverflow(createErrorMessage("429 status code (no body)"))).toBe(false);
	});
});

describe("isPayloadRejection - ambiguous no-body statuses", () => {
	it("co-flags bare '413 status code (no body)' as payload rejection while staying overflow", () => {
		// Proxies strip bodies on genuine token overflows AND on byte-limit hits;
		// text alone cannot arbitrate, so both flags set and session maintenance
		// arbitrates against local token headroom (#9235).
		const message = createErrorMessage("413 status code (no body)");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(true);
	});

	it("does not co-flag bare '400 status code (no body)'", () => {
		const message = createErrorMessage("400 status code (no body)");
		expect(isContextOverflow(message)).toBe(true);
		expect(isPayloadRejection(message)).toBe(false);
	});
});

describe("retriable - transient-wrapped payload rejections (#9235 review)", () => {
	it("keeps transient-wrapped payload rejections non-retryable", () => {
		const id = AIError.classifyMessage({ errorMessage: "Provider returned error: 413 Payload Too Large" });
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps plain transport failures retryable", () => {
		const id = AIError.classifyMessage({ errorMessage: "503 service unavailable" });
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});
});

describe("classifyMessage - status-only 413 responses (#9235 review)", () => {
	it("classifies a bare 413 status with an opaque reason phrase as payload rejection", () => {
		// Adapters surface request-size rejections as a status plus a generic
		// reason phrase; no text names tokens, but resending identical bytes
		// cannot succeed, so the payload flag must gate retries.
		const id = AIError.classifyMessage({ errorStatus: 413, errorMessage: "Content Too Large" });
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("classifies a completely body-less 413 as payload rejection", () => {
		const id = AIError.classifyMessage({ errorStatus: 413 });
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
	});

	it("does not promote other statuses to payload rejection", () => {
		const id = AIError.classifyMessage({ errorStatus: 400, errorMessage: "Content Too Large" });
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(false);
	});

	it("keeps token-context evidence outranking the status fallback", () => {
		// A 413 whose body carries genuine token wording stays on the
		// compaction path — provider token accounting beats the bare status.
		const id = AIError.classifyMessage({
			errorStatus: 413,
			errorMessage: "maximum context length is 128000 tokens",
		});
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(false);
	});
	it("keeps the payload flag for a status-413 media-budget body", () => {
		// The generic numeric pattern also matches media budgets, but those
		// are exactly the rejections token compaction cannot fix: with no
		// token-context wording in the body, the 413 status alone is payload
		// evidence and must not be stripped (#9235 review).
		const id = AIError.classifyMessage({
			errorStatus: 413,
			errorMessage: "image count exceeds the limit of 20",
		});
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps the payload flag for a status-413 byte-size body", () => {
		const id = AIError.classifyMessage({
			errorStatus: 413,
			errorMessage: "request body exceeds the limit of 10 MB",
		});
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
	});
});

describe("classify - token evidence arbitrates the status fallback across cause links (#9235 review)", () => {
	it("keeps a wrapped token overflow pure when the wrapper's status comes from a nested 413", () => {
		// status() recurses into causes, so a generic wrapper gains a 413 from
		// its nested link; when that link names the token budget, the payload
		// inference must lose to the provider's explicit overflow evidence.
		const inner = Object.assign(new Error("Error: maximum context length is 128000 tokens"), { status: 413 });
		const id = AIError.classify(new Error("Provider returned error", { cause: inner }));
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(false);
	});

	it("keeps the status-derived payload flag for an opaque nested 413", () => {
		// No link carries token wording: the recursively-derived 413 remains
		// valid request-size evidence.
		const inner = Object.assign(new Error("Content Too Large"), { status: 413 });
		const id = AIError.classify(new Error("Provider returned error", { cause: inner }));
		expect(AIError.is(id, AIError.Flag.PayloadRejected)).toBe(true);
	});
});
