import { describe, expect, it } from "bun:test";
import { planAdvisorUsageLimitWait } from "../src/session/session-advisors";

const retry = { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000, maxRetries: 3 };

describe("advisor endpoint retry wait", () => {
	it("honors an explicit delay and the configured backoff floor", () => {
		expect(planAdvisorUsageLimitWait({ retry, attempt: 0, retryAfterMs: 5000 })).toBe(5000);
		// The backoff floor applies 0–25% downward jitter to the 4s (2²·1s) cap.
		const floor = planAdvisorUsageLimitWait({ retry, attempt: 2, retryAfterMs: 0 });
		expect(floor).toBeGreaterThanOrEqual(3000);
		expect(floor).toBeLessThanOrEqual(4000);
	});
	it("declines missing or invalid hints instead of waiting on an imagined account reset", () => {
		expect(planAdvisorUsageLimitWait({ retry, attempt: 0 })).toBeUndefined();
		expect(planAdvisorUsageLimitWait({ retry, attempt: 0, retryAfterMs: Infinity })).toBeUndefined();
	});
	it("respects both delay and attempt limits", () => {
		expect(planAdvisorUsageLimitWait({ retry, attempt: 0, retryAfterMs: 30001 })).toBeUndefined();
		expect(planAdvisorUsageLimitWait({ retry, attempt: 3, retryAfterMs: 10 })).toBeUndefined();
		expect(
			planAdvisorUsageLimitWait({ retry: { ...retry, maxRetries: 0 }, attempt: 0, retryAfterMs: 10 }),
		).toBeUndefined();
	});
	it("supports disabled retries and an explicitly unlimited delay", () => {
		expect(
			planAdvisorUsageLimitWait({ retry: { ...retry, enabled: false }, attempt: 0, retryAfterMs: 10 }),
		).toBeUndefined();
		expect(planAdvisorUsageLimitWait({ retry: { ...retry, maxDelayMs: 0 }, attempt: 0, retryAfterMs: 60000 })).toBe(
			60000,
		);
	});
});
