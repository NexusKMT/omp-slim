import type { Context, Model } from "@oh-my-pi/pi-ai";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { Tokenizer } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Local counts are padded by 1/this before sizing the output cap: the
 * provider's tokenizer can disagree with ours by a few percent, and
 * undercounting reproduces the overflow this guards against.
 */
const PROMPT_ESTIMATE_MARGIN_DIVISOR = 10;

/**
 * Output cap for a request, so prompt plus output stays inside the model's
 * context window.
 *
 * Chat Completions-style providers (DeepSeek, OpenAI, vLLM, ...) reject a
 * request whose prompt tokens plus `max_tokens` exceed the window. Every
 * request asks for `model.maxTokens` of output by default, so without this a
 * large model output cap (DeepSeek V4: ~384k of a ~1M window) makes every
 * request fail once the prompt passes window minus output cap, long before
 * compaction triggers, and side turns (`/btw`, recaps) have no overflow
 * recovery at all.
 *
 * Returns `maxTokens` unchanged when the requested cap already fits, the
 * model declares no window, or nothing would be requested. Otherwise returns
 * the remaining room (never below {@link MIN_FITTED_OUTPUT_TOKENS}); a
 * prompt that fills the whole window still overflows and is left to the
 * caller's compaction.
 */
export function fitOutputTokensToContextWindow(
	model: Pick<Model, "contextWindow" | "maxTokens">,
	context: Context,
	maxTokens: number | undefined,
	tokenizer: Tokenizer,
): number | undefined {
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;

	const counted = countContextTokens(context, tokenizer);
	const promptTokens = counted + Math.ceil(counted / PROMPT_ESTIMATE_MARGIN_DIVISOR);
	const room = contextWindow - promptTokens;
	if (room >= requested) return maxTokens;
	return Math.max(MIN_FITTED_OUTPUT_TOKENS, room);
}

function countContextTokens(context: Context, tokenizer: Tokenizer): number {
	const fragments: string[] = context.systemPrompt ? [...context.systemPrompt] : [];
	for (const tool of context.tools ?? []) {
		fragments.push(tool.name, tool.description, stringifyJson(tool.parameters) ?? "");
	}
	const framing = fragments.length === 0 ? 0 : tokenizer.countTokens(fragments);
	return framing + tokenizer.countMessages(context.messages);
}
