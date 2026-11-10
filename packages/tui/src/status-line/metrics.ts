import type { Theme } from "../theme";

/** Cost rollup shown by status segments and the legacy footer. */
export interface BillingSummaryOptions {
	readonly cost: number;
	readonly fractionDigits: number;
	readonly pricingPeriod?: "peak" | "off-peak";
	/** Subagent-tree spend, rendered after the session's own spend; `cost` excludes it. */
	readonly subagentCost?: number;
	readonly advisor?: { readonly cost: number };
}

/** Render metered session, subagent and advisor costs with one currency symbol. */
export function formatBillingSummary(options: BillingSummaryOptions, uiTheme: Theme): string | undefined {
	const advisorCost = options.advisor?.cost ?? 0;
	const subagentCost = options.subagentCost ?? 0;
	if (!options.cost && !subagentCost && !advisorCost && !options.pricingPeriod) return undefined;

	const parts: string[] = [];
	if (options.cost || options.pricingPeriod || subagentCost) {
		parts.push(`$${options.cost.toFixed(options.fractionDigits)}`);
	}
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(options.fractionDigits)})`);
	if (options.pricingPeriod) parts.push(options.pricingPeriod === "peak" ? "↑" : "↓");
	if (advisorCost) {
		const prefix = parts.length > 0 ? "+ " : "";
		const spend = `${parts.length > 0 ? "" : "$"}${advisorCost.toFixed(options.fractionDigits)}`;
		const icon = uiTheme.icon.advisor;
		parts.push(`${prefix}${icon && icon !== "(adv)" ? `${icon} ${spend}` : `${spend} (adv)`}`);
	}
	return parts.join(" ");
}
