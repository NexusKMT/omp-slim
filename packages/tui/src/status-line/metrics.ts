import type { Theme } from "../theme";

/** Cost rollup shown by status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly fractionDigits: number;
	readonly pricingPeriod?: "peak" | "off-peak";
	/** Subagent-tree spend, rendered after the session's own spend; `cost` excludes it. */
	readonly subagentCost?: number;
}

/** Render metered session and subagent costs with one currency symbol. */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const subagentCost = options.subagentCost ?? 0;
	if (!options.cost && !subagentCost && !options.pricingPeriod) return undefined;

	const parts: string[] = [];
	if (options.cost || options.pricingPeriod || subagentCost) {
		parts.push(`$${options.cost.toFixed(options.fractionDigits)}`);
	}
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(options.fractionDigits)})`);
	if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
	return parts.join(" ");
}
