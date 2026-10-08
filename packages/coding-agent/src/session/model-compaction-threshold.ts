import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelCompactionPoint } from "@oh-my-pi/pi-tui/overlays/model-browser";
import {
	applyModelCompactionThreshold,
	formatCompactionPointInput,
	matchModelCompactionThreshold,
	parseCompactionPointInput,
} from "../config/compaction-threshold";
import type { ScopeLike } from "../config/registry";
import { type CompactionSettings, cfgCompaction, cfgCompactionModelThresholds } from "./context-settings";

/** The compaction policy in force for `model`: the configured policy with its `compaction.modelThresholds` entry applied. */
export function resolveModelCompactionSettings(
	scope: ScopeLike,
	model: { provider: string; id: string } | null | undefined,
): CompactionSettings {
	return applyModelCompactionThreshold(cfgCompaction.get(scope), cfgCompactionModelThresholds.get(scope), model);
}

/** Where auto-compaction triggers for `model` and which setting decides it, for the model hub preview. */
export function describeModelCompactionPoint(scope: ScopeLike, model: Model): ModelCompactionPoint {
	const configured = cfgCompaction.get(scope);
	const match = matchModelCompactionThreshold(cfgCompactionModelThresholds.get(scope), model);
	const settings = applyModelCompactionThreshold(configured, cfgCompactionModelThresholds.get(scope), model);
	const contextWindow = model.contextWindow ?? 0;
	return {
		tokens: settings.enabled && contextWindow > 0 ? resolveThresholdTokens(contextWindow, settings) : undefined,
		percent: settings.thresholdTokens > 0 || settings.thresholdPercent <= 0 ? undefined : settings.thresholdPercent,
		source: match?.key ?? (configured.thresholdTokens > 0 || configured.thresholdPercent > 0 ? "global" : "default"),
		draft: match?.key === `${model.provider}/${model.id}` ? formatCompactionPointInput(match.threshold) : undefined,
	};
}

/**
 * Persist `input` (see {@link parseCompactionPointInput}) as `model`'s own
 * `compaction.modelThresholds` entry in the global config; empty input removes
 * it. Throws on unparseable input. Returns the entry written, or `undefined` when removed.
 */
export function setModelCompactionPoint(scope: ScopeLike, model: Model, input: string): number | string | undefined {
	const entry = parseCompactionPointInput(input) ?? undefined;
	cfgCompactionModelThresholds.setEntry(scope, `${model.provider}/${model.id}`, entry);
	return entry;
}
