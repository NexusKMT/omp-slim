import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { describe, expect, it } from "bun:test";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("error-id classification", () => {
	it("composes timeout with transient", () => {
		const id = AIError.classify(new Error("provider stream stall timeout"), "openai-completions");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
	});

	it("classifies a stream_read_error as transient", () => {
		const assistant = message({
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			errorMessage: "Error Code stream_read_error: stream_read_error",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies provider connection failures as transient", () => {
		for (const errorMessage of ["Unable to connect. Is the computer able to access the url?", "Socket is closed"]) {
			const id = AIError.classifyMessage(message({ errorMessage }));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});
	it.each([
		"error decoding response body",
		"Provider stream error (api_error): invalid response",
		"Failed to parse tool call arguments as JSON",
		"Provider stream error (authentication_error): 401 Unauthorized",
	])("does not infer a transport retry from unrelated failures: %s", errorMessage => {
		const error = new AIError.ProviderResponseError(errorMessage, { provider: "test", kind: "output" });
		const id = AIError.classifyMessage(message({ errorMessage }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
		expect(AIError.isProviderRetryableError(error)).toBe(false);
	});

	it("classifies bare stream-truncation diagnostics as transient + retryable", () => {
		for (const errorMessage of ["unexpected EOF", "unexpected end of json input", "eof while parsing"]) {
			const id = AIError.classifyMessage(message({ errorMessage }));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("keeps a truncation phrase riding on a terminal 4xx terminal", () => {
		const messages = [
			message({ errorStatus: 400, errorMessage: "unexpected EOF" }),
			message({ errorMessage: "HTTP 400: unexpected EOF" }),
			message({ errorMessage: "400 Bad Request: eof while parsing" }),
		];
		for (const assistant of messages) {
			const id = AIError.classifyMessage(assistant);
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
			expect(AIError.retriable(id)).toBe(false);
		}
	});

	it("keeps a truncation on a retryable 408/429 status transient + retryable", () => {
		for (const errorStatus of [408, 429]) {
			const id = AIError.classifyMessage(message({ errorStatus, errorMessage: "unexpected EOF" }));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("keeps low-signal truncation words unclassified on persisted text", () => {
		for (const errorMessage of ["truncated", "end of file"]) {
			const id = AIError.classifyMessage(message({ errorMessage }));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
			expect(AIError.retriable(id)).toBe(false);
		}
	});

	it.each([
		"stream error: stream disconnected before completion: stream closed before response.completed",
		"Upstream response stream was interrupted",
		"Upstream stream ended before terminal chunk",
		"Client network socket disconnected before secure TLS connection was established",
	])("classifies statusless stream-drop families as transient + retryable on both paths: %s", errorMessage => {
		const id = AIError.classifyMessage(message({ errorMessage }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
		expect(AIError.isProviderRetryableError(new Error(errorMessage))).toBe(true);
	});

	it("keeps a stream-drop phrase riding on a terminal 4xx terminal", () => {
		const errorMessage = "stream closed before response.completed";
		const id = AIError.classifyMessage(message({ errorStatus: 400, errorMessage }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
		expect(AIError.isProviderRetryableError(new AIError.ProviderHttpError(errorMessage, 400))).toBe(false);
	});

	it("keeps transport wording on a terminal 4xx terminal while 408/429/5xx stay retryable (#13807)", () => {
		const body =
			"Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it. (type=server_error)";
		const denied = AIError.classify(message({ errorStatus: 400, errorMessage: `400 ${body}` }));
		expect(AIError.is(denied, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(denied)).toBe(false);
		for (const errorStatus of [408, 429, 503]) {
			const id = AIError.classify(message({ errorStatus, errorMessage: `${errorStatus} ${body}` }));
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("keeps Flag.Timeout when a timeout message also reads as a truncation", () => {
		const id = AIError.classifyMessage(message({ errorMessage: "read timed out: unexpected EOF" }));
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it.each([
		"The service is temporarily unavailable, please try again later",
		"Model temporarily_unavailable",
		"Temporary unavailable: capacity",
	])("classifies temporary-unavailability wording as transient + retryable: %s", errorMessage => {
		const id = AIError.classifyMessage(message({ errorMessage }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps temporary-unavailability wording on a terminal 4xx terminal", () => {
		const id = AIError.classifyMessage(
			message({ errorStatus: 403, errorMessage: "403 This model is temporarily unavailable on your plan" }),
		);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps authenticated connection rejections non-retryable", () => {
		const assistant = message({
			errorMessage: "Unable to connect: 401 Unauthorized",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps provider content filters non-retryable", () => {
		const error = new AIError.ProviderResponseError("Provider returned error finish_reason: content_filter", {
			provider: "test",
			kind: "content-blocked",
		});
		const id = AIError.classify(error, "openai-completions");
		expect(AIError.is(id, AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.is(id, AIError.Flag.ProviderFinishError)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});
	it("walks causes and preserves carried ids", () => {
		const inner = AIError.attach(new Error("inner"), AIError.create(AIError.Flag.ThinkingLoop));
		const outer = new Error("outer", { cause: inner });
		const id = AIError.classify(outer, "openai-completions");
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	it("combines wrapper text classification with cause ids", () => {
		const cause = AIError.attach(new Error("quota reached"), AIError.create(AIError.Flag.UsageLimit));
		const outer = new Error("network stream stall", { cause });
		const id = AIError.classify(outer, "openai-completions");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("upgrades a stamped status fallback after final error text exists", () => {
		const assistant = message({
			errorId: 503,
			errorStatus: 503,
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});
	it("retries Go closed-connection transport errors forwarded by a gateway (#15385)", () => {
		const errorMessage = "read tcp 127.0.0.1:9426->127.0.0.1:9050: use of closed network connection";
		const id = AIError.classifyMessage(
			message({ api: "openai-completions", provider: "custom-gateway", model: "mimo", errorId: 0, errorMessage }),
		);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
		expect(AIError.isProviderRetryableError(new Error(errorMessage))).toBe(true);
	});

	it("retries remote Python HTTP/2 internal and refused stream resets", () => {
		for (const code of [2, 7]) {
			const assistant = message({
				api: "openai-completions",
				provider: "test",
				errorId: 0,
				errorMessage: `Provider error event: <StreamReset stream_id:1283, error_code:${code}, remote_reset:True> (code=api_error)`,
			});
			expect(AIError.retriable(AIError.classifyMessage(assistant))).toBe(true);
		}
	});

	it("keeps other Python stream resets outside transient recovery", () => {
		for (const details of [
			"error_code:8, remote_reset:True",
			"error_code:20, remote_reset:True",
			"error_code:2, remote_reset:False",
			"error_code:2",
		]) {
			const assistant = message({
				api: "openai-completions",
				provider: "test",
				errorMessage: `Provider error event: <StreamReset stream_id:1283, ${details}> (code=api_error)`,
			});
			expect(AIError.retriable(AIError.classifyMessage(assistant))).toBe(false);
		}
	});

	it("keeps generic API and chunk-format errors outside transient recovery", () => {
		for (const errorMessage of [
			"Provider error event: invalid chunk header (code=api_error)",
			"Provider error event: malformed chunk footer (code=api_error)",
			"Provider error event: invalid request body (code=api_error)",
		]) {
			const assistant = message({
				api: "openai-completions",
				provider: "test",
				errorMessage,
			});
			expect(AIError.retriable(AIError.classifyMessage(assistant))).toBe(false);
		}
	});

	it("merges existing cause-chain kinds with finalized error text kinds", () => {
		const assistant = message({
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});
});
