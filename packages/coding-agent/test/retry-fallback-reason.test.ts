import { expect, test } from "bun:test";
import { describeUsageFallback } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-reason";

test("does not describe plan-ineligible accounts as exhausted quota", () => {
	// Health drops plan-ineligible accounts before computing the depleted state.
	const reason = describeUsageFallback({ state: "depleted", accounts: [] }, 30);
	expect(reason).toMatch(/eligible.*plan/);
	expect(reason).not.toMatch(/quota-exhausted|temporarily blocked/);
});
