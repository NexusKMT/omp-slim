import type { ModelUsageHealth } from "@oh-my-pi/pi-ai";

/** Describe the health snapshot that actually caused a preflight switch. */
export function describeUsageFallback(health: ModelUsageHealth, reservePercent: number): string {
	const condition =
		health.state === "reserve"
			? `available quota is at or below the ${reservePercent}% reserve`
			: health.accounts.length === 0
				? "no account is eligible for this model's plan requirements"
				: "all eligible accounts are quota-exhausted or temporarily blocked";
	const resets = health.accounts
		.map(account => account.resetsAt)
		.filter((reset): reset is number => reset !== undefined && Number.isFinite(reset));
	const reset = resets.length > 0 ? ` Earliest reported reset: ${new Date(Math.min(...resets)).toISOString()}.` : "";
	return `Usage preflight: ${condition}.${reset} No request was sent to the source model for this attempt.`;
}
