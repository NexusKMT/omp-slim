import { isRecord } from "@oh-my-pi/pi-utils";

type ParsedCompactionThresholdOverride = { kind: "percent"; value: number } | { kind: "tokens"; value: number };

const PERCENT_OVERRIDE_PATTERN = /^(?:[1-9]|[1-9]\d)%$/;
const TOKEN_OVERRIDE_PATTERN = /^[1-9]\d*$/;

function parseCompactionThresholdOverride(value: unknown): ParsedCompactionThresholdOverride | undefined {
	if (typeof value !== "string") return undefined;
	if (PERCENT_OVERRIDE_PATTERN.test(value)) {
		return { kind: "percent", value: Number(value.slice(0, -1)) };
	}
	if (TOKEN_OVERRIDE_PATTERN.test(value)) {
		const tokens = Number(value);
		if (Number.isSafeInteger(tokens)) return { kind: "tokens", value: tokens };
	}
	return undefined;
}

function invalidOverrideDescription(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	return typeof value;
}

const EXPECTED_OVERRIDE_FORMAT = "an integer percentage from 1% to 99% or a positive safe integer token limit";

function invalidThresholdMapContainer(value: unknown): Error {
	const kind = Array.isArray(value)
		? "an array"
		: value === null
			? "null"
			: typeof value === "object"
				? "a non-map object"
				: `a ${typeof value}`;
	return new Error(
		`Invalid task.agentCompactionThresholdOverrides: expected a map of agent name to compaction threshold, got ${kind}.`,
	);
}

/** Resolve one exact-agent compaction override to the two child setting paths. */
export function resolveAgentCompactionThresholdOverride(override: string): {
	"compaction.thresholdPercent": number;
	"compaction.thresholdTokens": number;
} {
	const parsed = parseCompactionThresholdOverride(override);
	if (!parsed) {
		throw new Error(
			`Invalid agent compaction threshold override ${invalidOverrideDescription(override)}: expected ${EXPECTED_OVERRIDE_FORMAT}.`,
		);
	}
	return parsed.kind === "percent"
		? { "compaction.thresholdPercent": parsed.value, "compaction.thresholdTokens": -1 }
		: { "compaction.thresholdPercent": -1, "compaction.thresholdTokens": parsed.value };
}

/** Validate the sparse exact-agent-name override map used by task dispatch. */
export function validateAgentCompactionThresholdOverrides(value: unknown): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw invalidThresholdMapContainer(value);
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) throw invalidThresholdMapContainer(value);

	const entries: [string, string][] = [];
	for (const [agentName, setting] of Object.entries(value)) {
		if (typeof setting !== "string" || !parseCompactionThresholdOverride(setting)) {
			throw new Error(
				`Invalid compaction threshold for task.agentCompactionThresholdOverrides.${agentName}: expected ${EXPECTED_OVERRIDE_FORMAT}, got ${invalidOverrideDescription(setting)}.`,
			);
		}
		entries.push([agentName, setting]);
	}
	return Object.fromEntries(entries);
}
