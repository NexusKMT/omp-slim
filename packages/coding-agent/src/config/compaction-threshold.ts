import { isRecord } from "@oh-my-pi/pi-utils";

/** Numeric threshold fields accepted for one task/eval agent. */
export type AgentCompactionThresholdOverride = {
	thresholdPercent?: number;
	thresholdTokens?: number;
};

/** Validate and normalize the exact-agent compaction threshold map. */
export function validateAgentCompactionThresholdOverrides(
	value: unknown,
): Record<string, Required<AgentCompactionThresholdOverride>> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(
			`Invalid task.agentCompactionThresholdOverrides: expected a map of agent name to threshold settings, got ${received}.`,
		);
	}

	const overrides: [string, Required<AgentCompactionThresholdOverride>][] = [];
	for (const [agentName, rawEntry] of Object.entries(value)) {
		if (!isRecord(rawEntry)) {
			throw new Error(
				`Invalid task.agentCompactionThresholdOverrides.${agentName}: expected an object with thresholdPercent and/or thresholdTokens.`,
			);
		}

		const normalized = { thresholdPercent: -1, thresholdTokens: -1 };
		let hasThresholdField = false;
		for (const [field, rawThreshold] of Object.entries(rawEntry)) {
			if (field !== "thresholdPercent" && field !== "thresholdTokens") {
				throw new Error(
					`Invalid task.agentCompactionThresholdOverrides.${agentName}.${field}: unknown threshold field. Valid fields: thresholdPercent, thresholdTokens.`,
				);
			}
			if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold)) {
				throw new Error(
					`Invalid task.agentCompactionThresholdOverrides.${agentName}.${field}: expected a finite number, got ${String(rawThreshold)}.`,
				);
			}
			hasThresholdField = true;
			normalized[field] = rawThreshold;
		}
		if (!hasThresholdField) {
			throw new Error(
				`Invalid task.agentCompactionThresholdOverrides.${agentName}: expected thresholdPercent and/or thresholdTokens.`,
			);
		}
		overrides.push([agentName, normalized]);
	}
	return Object.fromEntries(overrides);
}
