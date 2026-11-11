import type { Context, Model, Tool } from "@oh-my-pi/pi-ai";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { findRequestUsageAnchor } from "./compaction/transcript-tokens";
import type { Tokenizer } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Local counts are padded by 1/this before sizing the output cap: the
 * provider's tokenizer can disagree with ours by a few percent, and
 * undercounting reproduces the overflow this guards against. This is a
 * tokenizer-error margin on locally counted text only (provider-reported
 * usage is exact), not a context reserve; compaction's own reserve
 * (`resolveBudgetReserveTokens`) still decides when to compact.
 */
const PROMPT_ESTIMATE_MARGIN_DIVISOR = 10;

/**
 * Chat-template framing charged per locally counted message. `Tokenizer.countMessage`
 * counts content only, but every template wraps each message in role markers and
 * separators, and tool results in response wrappers.
 * The proportional margin scales with content, so many short messages (a turn's
 * parallel tool results) leave this uncovered. Provider-anchored messages need no
 * charge: the host's own report already includes their framing.
 */
export const MESSAGE_FRAMING_TOKENS = 16;

/**
 * Absolute headway subtracted from the remaining room (unconditionally, on anchored and
 * fully-local counts alike). Covers per-request framing no message count sees: the
 * generation prompt, the anchoring turn's end marker, reasoning wrappers. Measured
 * against a 262,144-token host: fitted caps landed +11 to +42 tokens over and were
 * rejected with 400s. The {@link MIN_FITTED_OUTPUT_TOKENS} floor still applies.
 */
export const OUTPUT_FIT_HEADWAY_TOKENS = 64;

/**
 * Output cap for a request, so prompt plus output stays inside the model's
 * context window.
 *
 * Chat Completions endpoints may reject requests whose prompt and requested
 * output exceed the context window. Fitting the output cap protects normal
 * turns and side requests before compaction becomes necessary.
 *
 * The prompt size is the provider's own report from the newest trustworthy
 * assistant turn (see {@link findRequestUsageAnchor}) plus a local count of
 * only the messages appended after it; the whole context is counted locally
 * only when no turn can anchor (fresh or freshly rewritten context). Local
 * counts carry a proportional tokenizer margin plus
 * {@link MESSAGE_FRAMING_TOKENS} per message.
 *
 * Returns `maxTokens` unchanged when it fits, the model declares no window,
 * or no output is requested. Otherwise the cap is the remaining room minus
 * {@link OUTPUT_FIT_HEADWAY_TOKENS}, never below {@link MIN_FITTED_OUTPUT_TOKENS}.
 * A prompt that fills the whole window is left to the caller's compaction.
 * Callers apply this in their stream function because pi-ai has no tokenizer.
 */
export function fitOutputTokensToContextWindow(
	model: Model,
	context: Context,
	maxTokens: number | undefined,
	tokenizer: Tokenizer,
): number | undefined {
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;

	const room = contextWindow - countPromptTokens(context, tokenizer) - OUTPUT_FIT_HEADWAY_TOKENS;
	if (room >= requested) return maxTokens;
	return Math.max(MIN_FITTED_OUTPUT_TOKENS, room);
}

/**
 * Framing tokens (system prompt, tool definitions) memoized per array: these
 * are stable identities for the life of a turn, so side turns and repeat
 * requests do not re-stringify and re-tokenize them. Length is part of the key
 * to catch in-place growth.
 */
const framingCounts = new WeakMap<readonly unknown[], { tokenizer: Tokenizer; length: number; tokens: number }>();

function countFraming(items: readonly unknown[] | undefined, tokenizer: Tokenizer, fragments: () => string[]): number {
	if (!items || items.length === 0) return 0;
	const cached = framingCounts.get(items);
	if (cached && cached.tokenizer === tokenizer && cached.length === items.length) return cached.tokens;
	const tokens = tokenizer.countTokens(fragments());
	framingCounts.set(items, { tokenizer, length: items.length, tokens });
	return tokens;
}

function toolFragments(tools: readonly Tool[]): string[] {
	const fragments: string[] = [];
	for (const tool of tools) fragments.push(tool.name, tool.description, stringifyJson(tool.parameters) ?? "");
	return fragments;
}

function withMargin(localTokens: number): number {
	return localTokens + Math.ceil(localTokens / PROMPT_ESTIMATE_MARGIN_DIVISOR);
}

/** Provider-anchored prompt size; falls back to a full local count when nothing anchors. */
function countPromptTokens(context: Context, tokenizer: Tokenizer): number {
	const { messages } = context;
	const anchor = findRequestUsageAnchor(messages);
	if (!anchor) {
		return withMargin(countContextTokens(context, tokenizer)) + messages.length * MESSAGE_FRAMING_TOKENS;
	}
	let tail = 0;
	for (let index = anchor.index + 1; index < messages.length; index++) {
		tail += tokenizer.countMessage(messages[index]);
	}
	return anchor.tokens + withMargin(tail) + (messages.length - anchor.index - 1) * MESSAGE_FRAMING_TOKENS;
}

function countContextTokens(context: Context, tokenizer: Tokenizer): number {
	const { systemPrompt, tools, inactiveTools } = context;
	return (
		countFraming(systemPrompt, tokenizer, () => [...(systemPrompt ?? [])]) +
		countFraming(tools, tokenizer, () => toolFragments(tools ?? [])) +
		// Anthropic replays retired tool definitions, so they are prompt too.
		countFraming(inactiveTools, tokenizer, () => toolFragments(inactiveTools ?? [])) +
		tokenizer.countMessages(context.messages)
	);
}
