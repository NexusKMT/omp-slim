import type { EffectiveTokenCost, TimeBasedCost } from "./types";

export function dueDatedCard<T extends { effectiveFrom: number }>(
	cards: readonly T[],
	timestamp: number,
): T | undefined {
	let due: T | undefined;
	for (const candidate of cards) {
		if (candidate.effectiveFrom <= timestamp && (due === undefined || candidate.effectiveFrom > due.effectiveFrom)) {
			due = candidate;
		}
	}
	return due;
}

export function dueEffectiveRate(
	schedule: TimeBasedCost | undefined,
	timestamp: number,
): EffectiveTokenCost | undefined {
	return dueDatedCard(schedule?.effectiveRates ?? [], timestamp);
}
