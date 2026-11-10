/**
 * Thinking metadata: runtime field-read helpers.
 *
 * All capabilities come from explicit model metadata. No provider names,
 * model ids, or endpoint hosts affect the available effort levels.
 */
import { Effort, THINKING_EFFORTS } from "./effort";
import type { Api, Model, ModelSpec, ThinkingConfig } from "./types";

/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

/**
 * Neutral view of a model whose thinking ladder is unverified: `reasoning: false`
 * and no ladder. Re-entering policy resolution starts from it (the ladder is
 * derived output, not authored input), and requests without an effort send it so
 * no reasoning or disable fields reach an upstream that may reject them.
 */
export function withoutUnverifiedThinking<T extends { reasoning: boolean; thinking?: ThinkingConfig }>(model: T): T {
	if (!model.thinking?.unverified) return model;
	const { thinking: _derived, ...rest } = model;
	return { ...rest, reasoning: false } as T;
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * An unserved level first follows `thinking.effortMap` when the map sends it to
 * a served tier that reaches the wire unchanged (a gateway answering `medium`
 * as `high`); otherwise it climbs down to the nearest lower tier.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const effortMap = model.thinking?.effortMap;
	const aliased = effortMap?.[requested] as Effort | undefined;
	if (aliased !== undefined && levels.includes(aliased) && (effortMap![aliased] ?? aliased) === aliased) {
		return aliased;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}

/** Default effort from explicit metadata, falling back to its least supported effort. */
export function defaultSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	return model.thinking?.defaultLevel ?? minimumSupportedEffort(model);
}
