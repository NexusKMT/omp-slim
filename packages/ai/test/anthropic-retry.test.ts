import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";
import { describe, expect, it } from "bun:test";

describe("isProviderRetryableError", () => {
	it("retries known transient rate-limit errors", () => {
		expect(isProviderRetryableError(new Error("Rate limit exceeded"))).toBe(true);
		expect(isProviderRetryableError(new Error("error 1302 from upstream"))).toBe(true);
	});
	it("retries gateway stream drops before message_delta", () => {
		expect(
			isProviderRetryableError(new Error("Upstream stream ended before message_delta, reason=scanner_error")),
		).toBe(true);
		expect(
			isProviderRetryableError(new Error("Upstream stream ended before message_start, reason=scanner_error")),
		).toBe(true);
	});
	it("retries HTTP/2 stream errors (INTERNAL_ERROR)", () => {
		expect(
			isProviderRetryableError(new Error("stream error: stream ID 391; INTERNAL_ERROR; received from peer")),
		).toBe(true);
	});

	it("retries Bun socket closure errors", () => {
		expect(
			isProviderRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});

	it("retries first-event timeout errors", () => {
		expect(isProviderRetryableError(new Error("Provider stream timed out while waiting for the first event"))).toBe(
			true,
		);
	});

	it("does not retry non-transient validation errors", () => {
		expect(isProviderRetryableError(new Error("Invalid tool schema"))).toBe(false);
		// The HTTP rejection wins over a transient-looking response body.
		const badRequest = Object.assign(new Error("unexpected EOF"), { status: 400 });
		expect(isProviderRetryableError(badRequest)).toBe(false);
	});

	it("keeps transient-looking gateway errors terminal when the HTTP status is 400", () => {
		for (const text of [
			"The provided URL does not appear to be valid. Ensure it is correctly formatted.",
			"Download multimodal file timed out",
		]) {
			const message = `400 <400> InternalError.Algo.InvalidParameter: ${text}\n<400> InternalError.Algo.InvalidParameter: ${text} (type=invalid_request_error param=invalid_parameter_error)`;
			const err = Object.assign(new Error(message), { status: 400 });
			expect(isProviderRetryableError(err)).toBe(false);
		}
	});

	it("does not retry persistent account usage/quota limits despite rate-limit wording", () => {
		// Account-level 429 that says "rate limit" but is really a parked
		// credential (long retry-after). Must surface immediately so the
		// credential-rotation layer takes over instead of looping on backoff.
		expect(
			isProviderRetryableError(
				new Error(
					'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
				),
			),
		).toBe(false);
		expect(isProviderRetryableError(new Error("usage_limit_reached"))).toBe(false);
		expect(isProviderRetryableError(new Error("You have hit your usage limit"))).toBe(false);
		// Provider monthly spend-cap 429 (issue #4787): must not retry, or the
		// provider loop burns its budget on minutes-long retry-after backoff and
		// surfaces "Deadline exceeded" instead of the quota error.
		expect(
			isProviderRetryableError(
				new Error(
					'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
				),
			),
		).toBe(false);
		// A generic transient rate limit (no account/usage framing) still retries.
		expect(isProviderRetryableError(new Error("Rate limit exceeded"))).toBe(true);
	});
});
