/**
 * How a model line turns an input image into billed input tokens. Authored on
 * the `image-tokenization` catalog axis in `rules/classes/*.kdl`, so the
 * pricing follows the model's lineage on every host: Claude through
 * OpenRouter, Bedrock or Vertex is billed by Anthropic's rule, not by the
 * wire API carrying it.
 *
 * Resolved through the cascade on demand (like `delegation-bias`) rather than
 * baked onto `Model`, so `{ api, id }` targets without a built model resolve
 * too.
 */
import { classifyModel } from "../identity";
import { resolveCascade } from "./cascade";
import type { ModelIdentity } from "./types";

/** OpenAI image `detail` levels; `undefined` means the provider default (`auto`). */
export type ImageDetail = "auto" | "low" | "high" | "original";

export interface ImageSize {
	width: number;
	height: number;
}

/** One OpenAI `detail` level's sizing: a pixel-dimension limit, then an optional patch budget. */
export interface PatchSizing {
	/** Longest side after the pixel-dimension fit. */
	maxEdge: number;
	/** Resizing patch budget; absent when the level keeps the image's size. */
	patchBudget?: number;
}

/** OpenAI 32px patches × a per-model multiplier, sized per `detail` level. */
export interface OpenAiPatchTokenization {
	regime: "openai-patch";
	multiplier: number;
	low: PatchSizing;
	high: PatchSizing;
	original: PatchSizing;
	/** The level `auto` (and an omitted `detail`) sizes like. */
	auto: "high" | "original";
}

/**
 * One model line's image billing rule. The regime selects the provider's
 * formula; the numbers are the model's own parameters from the vendor docs.
 */
export type ImageTokenization =
	| OpenAiPatchTokenization
	/** OpenAI legacy tiles: fit 2048px, short side to 768px, `base` + `tile` per 512px square. */
	| { regime: "openai-tile"; baseTokens: number; tileTokens: number }
	/** Anthropic 28px patches, resized to fit a padded-edge limit and a visual-token budget. */
	| { regime: "anthropic-patch"; maxEdge: number; maxTokens: number }
	/** A fixed per-image budget regardless of pixels (Gemini 3 `media_resolution`). */
	| { regime: "fixed"; tokens: number };

/**
 * GPT-5.5's image billing: the estimate for images whose reading model is
 * unknown or has no catalog rule. Current GPT models size `auto` like
 * `original`, so it takes the larger budget rather than risk undercounting.
 */
export const DEFAULT_OPENAI_PATCH_TOKENIZATION: OpenAiPatchTokenization = {
	regime: "openai-patch",
	multiplier: 1.2,
	low: { maxEdge: 512 },
	high: { maxEdge: 2048, patchBudget: 2_500 },
	original: { maxEdge: 6_000, patchBudget: 10_000 },
	auto: "original",
};

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parsePatchSizing(value: unknown): PatchSizing | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const maxEdge = positive("maxEdge" in value ? value.maxEdge : undefined);
	if (maxEdge === undefined) return undefined;
	if (!("patchBudget" in value)) return { maxEdge };
	const patchBudget = positive(value.patchBudget);
	return patchBudget === undefined ? undefined : { maxEdge, patchBudget };
}

/** Validate a resolved `image-tokenization` payload; malformed payloads resolve to undefined. */
export function parseImageTokenization(value: unknown): ImageTokenization | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const payload = value as Record<string, unknown>;
	switch (payload.regime) {
		case "openai-patch": {
			const multiplier = positive(payload.multiplier);
			const low = parsePatchSizing(payload.low);
			const high = parsePatchSizing(payload.high);
			const original = parsePatchSizing(payload.original);
			const auto = payload.auto;
			if (multiplier === undefined || !low || !high || !original || (auto !== "high" && auto !== "original")) {
				return undefined;
			}
			return { regime: "openai-patch", multiplier, low, high, original, auto };
		}
		case "openai-tile": {
			const baseTokens = positive(payload.baseTokens);
			const tileTokens = positive(payload.tileTokens);
			return baseTokens === undefined || tileTokens === undefined
				? undefined
				: { regime: "openai-tile", baseTokens, tileTokens };
		}
		case "anthropic-patch": {
			const maxEdge = positive(payload.maxEdge);
			const maxTokens = positive(payload.maxTokens);
			return maxEdge === undefined || maxTokens === undefined
				? undefined
				: { regime: "anthropic-patch", maxEdge, maxTokens };
		}
		case "fixed": {
			const tokens = positive(payload.tokens);
			return tokens === undefined ? undefined : { regime: "fixed", tokens };
		}
		default:
			return undefined;
	}
}

/** What reads the image: a built model, or any `{ id }` with optional host and identity. */
export interface ImageTokenizationTarget {
	id: string;
	provider?: string;
	api?: string;
	identity?: Pick<ModelIdentity, "class" | "family" | "revision">;
}

/**
 * The model's image billing rule, or undefined when no lineage rule covers it
 * (callers keep their own fallback). Targets without an `identity` are
 * classified from the id.
 */
export function resolveImageTokenization(target: ImageTokenizationTarget): ImageTokenization | undefined {
	const provider = target.provider ?? "";
	const identity = target.identity ?? classifyModel(provider, target.id, { lenient: true });
	return parseImageTokenization(
		resolveCascade({
			provider,
			api: target.api ?? "",
			class: identity.class,
			model: target.id,
			reasoning: false,
			...(identity.family !== undefined && { family: identity.family }),
			...(identity.revision !== undefined && { revision: identity.revision }),
		}).catalog.imageTokenization,
	);
}

/** Scale `size` down (never up) so its longest side is at most `maxEdge`. */
function fitLongEdge(size: ImageSize, maxEdge: number): ImageSize {
	const longest = Math.max(size.width, size.height);
	if (longest <= maxEdge) return size;
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

const OPENAI_PATCH_PX = 32;

function openAiPatches(size: ImageSize, sizing: PatchSizing): number {
	const { width, height } = fitLongEdge(size, sizing.maxEdge);
	const patches = Math.ceil(width / OPENAI_PATCH_PX) * Math.ceil(height / OPENAI_PATCH_PX);
	const budget = sizing.patchBudget;
	if (budget === undefined || patches <= budget) return patches;

	const shrink = Math.sqrt((OPENAI_PATCH_PX * OPENAI_PATCH_PX * budget) / (width * height));
	const scaledW = (width * shrink) / OPENAI_PATCH_PX;
	const scaledH = (height * shrink) / OPENAI_PATCH_PX;
	const adjusted = shrink * Math.min(Math.floor(scaledW) / scaledW, Math.floor(scaledH) / scaledH);
	const resizedW = Math.floor(width * adjusted);
	const resizedH = Math.floor(height * adjusted);
	if (resizedW <= 0 || resizedH <= 0) return budget;
	return Math.min(budget, Math.ceil(resizedW / OPENAI_PATCH_PX) * Math.ceil(resizedH / OPENAI_PATCH_PX));
}

const TILE_FIT_PX = 2048;
const TILE_SHORT_SIDE_PX = 768;
const TILE_PX = 512;

function openAiTiles(size: ImageSize): number {
	let { width, height } = fitLongEdge(size, TILE_FIT_PX);
	const shortest = Math.min(width, height);
	if (shortest > TILE_SHORT_SIDE_PX) {
		const scale = TILE_SHORT_SIDE_PX / shortest;
		width = width === shortest ? TILE_SHORT_SIDE_PX : Math.floor(width * scale);
		height = height === shortest ? TILE_SHORT_SIDE_PX : Math.floor(height * scale);
	}
	return Math.ceil(width / TILE_PX) * Math.ceil(height / TILE_PX);
}

const ANTHROPIC_PATCH_PX = 28;

/** Round half to even, like the API's resize (and Python's `round`). */
function roundTiesToEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Anthropic visual tokens after the API's resize: the largest
 * aspect-preserving size whose 28px-padded edges fit `maxEdge` and whose
 * patch count fits `maxTokens`, found by bisecting the long edge. Port of the
 * reference implementation:
 * <https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading>
 */
function anthropicTokens(size: ImageSize, maxEdge: number, maxTokens: number): number {
	const long = Math.max(size.width, size.height);
	const shortSide = Math.min(size.width, size.height);
	const aspect = long / shortSide;
	const patches = (l: number, s: number) => Math.ceil(l / ANTHROPIC_PATCH_PX) * Math.ceil(s / ANTHROPIC_PATCH_PX);
	const fits = (l: number, s: number) =>
		Math.ceil(l / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		Math.ceil(s / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		patches(l, s) <= maxTokens;
	const short = (l: number) => Math.max(roundTiesToEven(l / aspect), 1);
	if (fits(long, shortSide)) return patches(long, shortSide);
	let lo = 1; // always fits
	let hi = long; // never fits
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (fits(mid, short(mid))) lo = mid;
		else hi = mid;
	}
	return patches(lo, short(lo));
}

/**
 * Billed input tokens for one image of `size` under `rule`, sent with
 * `detail` (only OpenAI regimes read it). Follows the vendors' published
 * formulas:
 * - OpenAI patches: <https://developers.openai.com/api/docs/guides/images-vision#patch-based-image-tokenization>
 * - OpenAI tiles: <https://developers.openai.com/api/docs/guides/images-vision#tile-based-image-tokenization>
 * - Anthropic: ⌈w/28⌉·⌈h/28⌉ of the resized image:
 *   <https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images>
 */
export function imageTokens(rule: ImageTokenization, size: ImageSize, detail?: ImageDetail): number {
	switch (rule.regime) {
		case "fixed":
			return rule.tokens;
		case "openai-patch": {
			const level = detail === "low" || detail === "high" || detail === "original" ? detail : rule.auto;
			return Math.ceil(openAiPatches(size, rule[level]) * rule.multiplier);
		}
		case "openai-tile":
			return detail === "low" ? rule.baseTokens : rule.baseTokens + openAiTiles(size) * rule.tileTokens;
		case "anthropic-patch":
			return anthropicTokens(size, rule.maxEdge, rule.maxTokens);
	}
}
