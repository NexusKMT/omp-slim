import { isRecord } from "@oh-my-pi/pi-utils";

/** Numeric threshold fields accepted for one task/eval agent. */
export type AgentCompactionThresholdOverride = {
	thresholdPercent?: number;
	thresholdTokens?: number;
};

/** Normalize one agent entry into both child threshold settings when usable. */
export function resolveAgentCompactionThresholdOverride(value: unknown):
	| {
			thresholdPercent: number;
			thresholdTokens: number;
	  }
	| undefined {
	if (!isRecord(value)) return undefined;

	const thresholdPercent =
		typeof value.thresholdPercent === "number" && Number.isFinite(value.thresholdPercent)
			? value.thresholdPercent
			: undefined;
	const thresholdTokens =
		typeof value.thresholdTokens === "number" && Number.isFinite(value.thresholdTokens)
			? value.thresholdTokens
			: undefined;
	if (thresholdPercent === undefined && thresholdTokens === undefined) return undefined;

	return {
		thresholdPercent: thresholdPercent ?? -1,
		thresholdTokens: thresholdTokens ?? -1,
	};
}
