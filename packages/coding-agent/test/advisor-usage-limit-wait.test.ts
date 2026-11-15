/**
 * Contract: `planAdvisorUsageLimitWait` decides whether an advisor waits out a
 * usage-limit credential block and retries, or declines so `AdvisorRuntime`
 * latches its permanent quota state. A regression here re-bricks the advisor on
 * a transient 429 (issue #11947) or, inverted, makes it sleep on a genuine
 * multi-hour quota window instead of pausing.
 */
import { describe, expect, it } from "bun:test";
import { planAdvisorUsageLimitWait } from "@oh-my-pi/pi-coding-agent/session/session-advisors";

const RETRY = { enabled: true, baseDelayMs: 500, maxDelayMs: 5 * 60 * 1000, maxRetries: 10 };

describe("planAdvisorUsageLimitWait", () => {
	it("waits out a transient block within retry.maxDelayMs and retries", () => {
		// Google 429 whose credential is blocked for ~50s, no sibling, no fallback.
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 50_000,
			retry: RETRY,
			attempt: 0,
		});
		expect(waitMs).toBe(50_000);
	});

	it("floors an expired provider wait with the configured retry backoff", () => {
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 0,
			retry: { ...RETRY, baseDelayMs: 1_000 },
			attempt: 0,
		});
		// Shared retry backoff applies 0–25% downward jitter to the 1s base.
		expect(waitMs).toBeGreaterThanOrEqual(750);
		expect(waitMs).toBeLessThanOrEqual(1_000);
	});

	it("declines (latch) when the block outlasts retry.maxDelayMs", () => {
		// A provider-stated 30-minute wait exceeds the 5-minute cap.
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 30 * 60 * 1000,
			retry: RETRY,
			attempt: 0,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) once the retry budget is spent", () => {
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 50_000,
			retry: RETRY,
			attempt: RETRY.maxRetries,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) immediately when maxRetries is 0", () => {
		// maxRetries=0 must mean no retries at all, matching the primary path.
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 50_000,
			retry: { ...RETRY, maxRetries: 0 },
			attempt: 0,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) when retry is disabled", () => {
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 50_000,
			retry: { ...RETRY, enabled: false },
			attempt: 0,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) when the error carries no authoritative timing", () => {
		const waitMs = planAdvisorUsageLimitWait({
			retry: RETRY,
			attempt: 0,
		});
		expect(waitMs).toBeUndefined();
	});
});
