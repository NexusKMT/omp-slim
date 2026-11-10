import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelTokenizer } from "@oh-my-pi/pi-catalog/types";
import * as natives from "@oh-my-pi/pi-natives";
import { materializeString, stringifyJson } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import { base64ImageSize, estimateImageTokens, type ImageDetail, type ImageSize } from "./image-tokens";
import type { AgentMessage } from "./types";

const testEnv = Bun.env.NODE_ENV === "test";

const NATIVE_ENCODING: Record<ModelTokenizer, natives.Encoding> = {
	"claude-v3": natives.Encoding.ClaudeV3,
	"claude-v47": natives.Encoding.ClaudeV47,
	"claude-v5": natives.Encoding.ClaudeV5,
	"claude-v5-sonnet": natives.Encoding.ClaudeV5Sonnet,
	qwen3: natives.Encoding.Qwen3,
	"deepseek-v3": natives.Encoding.DeepSeekV3,
	"kimi-k2": natives.Encoding.KimiK2,
	glm5: natives.Encoding.Glm5,
	cl100k: natives.Encoding.Cl100kBase,
	o200k: natives.Encoding.O200kBase,
};

/** Maps the catalog-resolved tokenizer family to its native implementation. */
export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): natives.Encoding | null {
	return model?.tokenizer ? NATIVE_ENCODING[model.tokenizer] : null;
}

type TokenizerModel = Pick<Model, "tokenizer">;

/**
 * Every mode counts with the native tokenizer: the catalog-resolved family
 * when known, o200k_base otherwise. They differ only in the fallback when the
 * loaded addon does not recognize that encoding: `strict` and `upperbound`
 * the raw byte length (never undercounts), `approximate` a bytes/4 guess.
 * Tests (`NODE_ENV=test`) skip the native count outside `strict` and use that
 * fallback.
 */
export type TokenCountMode = "strict" | "approximate" | "upperbound";

/** Options for {@link Tokenizer.countMessage} / {@link Tokenizer.countMessages}. */
export interface MessageCountOptions {
	/** Legacy compaction option. Chat replay already excludes all encrypted reasoning. */
	excludeEncryptedReasoning?: boolean;
}

function byteEstimate(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function sumFragments(text: string | string[], perFragment: (t: string) => number): number {
	return Array.isArray(text) ? text.reduce((sum, t) => sum + perFragment(t), 0) : perFragment(text);
}

interface NativeTokenCount {
	tokens: number;
	exact: boolean;
}

// Growing streamed text and large tool results must not evict the reusable
// short fragments. Account for UTF-16 key storage plus a per-entry allowance.
const NATIVE_CACHE_MAX_LENGTH = 16 * 1024;

function countNativeFragment(
	text: string,
	encoding: natives.Encoding | null | undefined,
	counts: LRUCache<string, number>,
): number {
	if (text.length > NATIVE_CACHE_MAX_LENGTH) return natives.countTokens(text, encoding);
	const cached = counts.get(text);
	if (cached !== undefined) return cached;
	const tokens = natives.countTokens(text, encoding);
	// Detach sliced strings so a small key cannot retain a much larger source.
	counts.set(materializeString(text), tokens);
	return tokens;
}

function countTokensNat(
	text: string | string[],
	encoding: natives.Encoding | null | undefined,
	mode: TokenCountMode,
	counts: LRUCache<string, number>,
): NativeTokenCount {
	try {
		let tokens: number;
		if (typeof text === "string") {
			tokens = countNativeFragment(text, encoding, counts);
		} else if (text.length > 0 && text.length < 16) {
			// The native API sums independent fragments, not their concatenation.
			// Keep its parallel batch path for arrays of 16 or more fragments.
			tokens = 0;
			for (const fragment of text) tokens += countNativeFragment(fragment, encoding, counts);
		} else {
			tokens = natives.countTokens(text, encoding);
		}
		return { tokens, exact: true };
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(!error.message.includes("does not match any variant of enum") &&
				!error.message.includes("unknown enum variant"))
		) {
			throw error;
		}
		const tokens = sumFragments(text, mode === "approximate" ? byteEstimate : byteLength);
		return { tokens, exact: false };
	}
}

/** Verdict from {@link Tokenizer.checkTokenBudget}. */
export interface TokenBudgetCheck {
	/** Whether the text fits the budget. */
	fits: boolean;
	/**
	 * Token count behind the verdict: the exact native count when `exact` is
	 * set, otherwise the conservative byte upper bound.
	 */
	tokens: number;
	/** Whether `tokens` came from the exact native tokenizer. */
	exact: boolean;
}

/**
 * Memoized estimates for one message under this tokenizer's encoding, split by
 * the {@link MessageCountOptions.excludeEncryptedReasoning} option so the two
 * variants never collide. `version` snapshots {@link messageEstimateVersion} at
 * write time; an owner mutation (prune/shake/strip-images) bumps the version,
 * which invalidates the entry in every live Tokenizer at once.
 */
interface MessageEstimate {
	version: number;
	default?: number;
	floored?: number;
}

/**
 * Model-aware local token counter. Immutable: the catalog-resolved encoding
 * is fixed at construction, so a cached count can never straddle two
 * encodings. An `Agent` owns one for its active model (swapping the instance
 * when the model's encoding, image or thinking-replay pricing, replay
 * identity or native-history replay state changes); one-shot flows construct
 * their own for the model that will be billed. Known tokenizer families use
 * exact native counts; other models are counted in o200k_base, which bills
 * unknown readers closer than a bytes/4 guess.
 */
export class Tokenizer {
	readonly #encoding: natives.Encoding | null;
	readonly #frameBilling: snapcompact.FrameBilling;
	readonly frameBillingKey: string;

	/** Exact counts only; byte fallbacks remain mode-dependent and uncached. */
	readonly #nativeCounts = new LRUCache<string, number>({
		max: 256,
		maxSize: 512 * 1024,
		sizeCalculation: (_tokens, text) => text.length * 2 + 64,
	});

	/**
	 * Per-message estimate memo. Keyed by message identity, deliberately not a
	 * symbol-tagged property: callers spread messages to derive throwaway
	 * variants for counting (`estimateBranchSummaryTokens` does
	 * `countMessage({ ...message, content: truncated })`), and a property-borne
	 * cache would ride along the spread. Identity keying gives clones a fresh
	 * count.
	 */
	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	constructor(model?: TokenizerModel | null) {
		this.#encoding = tokenizerEncodingForModel(model);
		this.#frameBilling = snapcompact.frameBilling();
		this.frameBillingKey = snapcompact.frameBillingKey(this.#frameBilling);
	}

	get encoding(): natives.Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (testEnv && mode !== "strict") return sumFragments(text, mode === "upperbound" ? byteLength : byteEstimate);
		return countTokensNat(text, this.#encoding, mode, this.#nativeCounts).tokens;
	}

	/**
	 * Cheap-first budget probe — the way to ask "does this fit in `budget`
	 * tokens?" without tokenizing the world.
	 *
	 * Byte length is a hard upper bound on token count (every token consumes at
	 * least one input byte), so text whose raw bytes already fit the budget
	 * cannot possibly exceed it — that verdict is returned without tokenizing at
	 * all. Only text that busts the bound is ambiguous, and only that case pays
	 * for the exact count. Since the bound overshoots ~4x on ordinary prose, the
	 * common "comfortably under budget" answer is free.
	 */
	checkTokenBudget(text: string | string[], budget: number): TokenBudgetCheck {
		const bound = sumFragments(text, byteLength);
		if (bound <= budget) return { fits: true, tokens: bound, exact: false };
		const result = countTokensNat(text, this.#encoding, "strict", this.#nativeCounts);
		return { fits: result.tokens <= budget, tokens: result.tokens, exact: result.exact };
	}

	/**
	 * Token estimate for one message under this tokenizer's encoding.
	 *
	 * Settled historical messages are counted once and reused until an owner
	 * (prune/shake/strip-images) calls `invalidateMessageCache`; streaming
	 * assistants bypass the memo entirely (see the message-cache settle-gate
	 * invariant). Image blocks charge {@link imageTokens}, the same estimate
	 * the native remote-compaction probe applies.
	 */
	countMessage(message: AgentMessage, options?: MessageCountOptions): number {
		const floored = options?.excludeEncryptedReasoning === true;
		if (!isEstimateCacheable(message)) return this.#measureMessage(message);
		const version = messageEstimateVersion(message);
		let entry = this.#estimates.get(message);
		if (entry === undefined || entry.version !== version) {
			entry = { version };
			this.#estimates.set(message, entry);
		}
		const cached = floored ? entry.floored : entry.default;
		if (cached !== undefined) return cached;
		const result = this.#measureMessage(message);
		if (floored) entry.floored = result;
		else entry.default = result;
		return result;
	}

	/**
	 * {@link countMessage} for the transcript's latest surviving assistant turn
	 * (`isSurvivingAssistant`), which an Anthropic Messages replay keeps
	 * byte-for-byte (`transformMessages`): a turn whose tool calls ended without
	 * a tool-use stop keeps its signatures then, so its reasoning is charged. A
	 * count of one message cannot see its position; a caller walking back from
	 * the end of the transcript counts that turn here. Not memoized: it differs
	 * from {@link countMessage} only for that one turn.
	 */
	countLatestTurn(message: AgentMessage, options?: MessageCountOptions): number {
		return this.countMessage(message, options);
	}

	/** Sum of {@link countMessage} over `messages`. */
	countMessages(messages: readonly AgentMessage[], options?: MessageCountOptions): number {
		let total = 0;
		for (const message of messages) total += this.countMessage(message, options);
		return total;
	}

	/**
	 * Input tokens for one image (not a snapcompact frame) under the reader's
	 * catalog image rule, or the generic estimate when it has none.
	 */
	imageTokens(size: ImageSize | null | undefined, detail?: ImageDetail): number {
		return estimateImageTokens(size, detail);
	}

	#measureMessage(message: AgentMessage): number {
		const fragments: string[] = [];
		let extra = 0;
		// Declaration-merged app roles (the coding-agent's bashExecution) are
		// invisible to this package's union, so the discriminant is read as data.
		const role: string = message.role;
		if (role === "bashExecution") {
			if ("command" in message && typeof message.command === "string") fragments.push(message.command);
			if ("output" in message && typeof message.output === "string") fragments.push(message.output);
			return fragments.length === 0 ? 0 : this.countTokens(fragments);
		}

		switch (message.role) {
			case "user":
			case "developer": {
				// Both roles carry `string | (TextContent | ImageContent)[]` and both are
				// sent to the provider -- convertMessageToLlm handles developer alongside
				// user -- so they are counted alike. Without the developer case the switch
				// fell through to `default: return 0`, and the old annotation narrowed the
				// blocks to text-only, hiding the image charge the toolResult arm applies.
				const content = message.content;
				if (typeof content === "string") {
					fragments.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += this.imageTokens(base64ImageSize(block.data), block.detail);
						}
					}
				}
				break;
			}
			case "assistant": {
				// Standard Chat replay includes visible text and structured function calls.
				for (const block of message.content) {
					if (block.type === "text") fragments.push(block.text);
					else if (block.type === "toolCall") {
						fragments.push(block.name);
						fragments.push(stringifyJson(block.arguments) ?? "null");
					}
				}
				break;
			}
			case "custom":
			case "hookMessage":
			case "toolResult": {
				if (typeof message.content === "string") {
					fragments.push(message.content);
				} else {
					for (const block of message.content) {
						if (block.type === "text" && block.text) {
							fragments.push(block.text);
						} else if (block.type === "image") {
							extra += this.imageTokens(base64ImageSize(block.data), block.detail);
						}
					}
				}
				break;
			}
			case "branchSummary":
			case "compactionSummary": {
				fragments.push(message.summary);
				if (message.role === "compactionSummary") {
					if (message.blocks) {
						for (const block of message.blocks) {
							if (block.type === "text") fragments.push(block.text);
							else extra += this.#frameTokens(block.data);
						}
					} else if (message.images) {
						for (const image of message.images) {
							extra += this.#frameTokens(image.data);
						}
					}
				}
				break;
			}
			default:
				return 0;
		}

		if (fragments.length === 0) return extra;
		return extra + this.countTokens(fragments);
	}

	/** Whether a model uses the same explicitly configured text encoding. */
	countsAlike(model: TokenizerModel | null | undefined): boolean {
		return tokenizerEncodingForModel(model) === this.#encoding;
	}

	/** Conservative generic budget for a compacted image frame. */
	#frameTokens(_data: string): number {
		return snapcompact.frameTokens(this.#frameBilling);
	}
}
