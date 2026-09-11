/**
 * Anthropic server-side compaction (`compact-2026-01-12` beta).
 *
 * The compaction request is the live turn's own request shape — same system
 * prompt, tools, and message history — plus the `compact_20260112` edit with
 * `pause_after_compaction`. The API summarizes the prompt from the already
 * cached prefix and stops; the summary arrives as a `compaction` block that
 * the provider surfaces as an `anthropicCompaction` payload. The summary is
 * plain text, so it doubles as the compaction entry's readable summary for
 * every other provider, while the Anthropic provider replays it as a native
 * block (the API drops everything that precedes it). The retained tail after
 * the cut point is replayed from session entries exactly like a local summary.
 */

import type {
	AnthropicCompactionPayload,
	ApiKey,
	Effort,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
	Usage,
} from "@oh-my-pi/pi-ai";
import { supportsAnthropicCompaction } from "@oh-my-pi/pi-ai/providers/anthropic";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type InstrumentedChatSpanOptions, instrumentedCompleteSimple } from "../telemetry";
import anthropicCompactionInstructionsPrompt from "./prompts/anthropic-compaction-instructions.md" with { type: "text" };

export const ANTHROPIC_COMPACTION_PRESERVE_KEY = "anthropicCompaction";

/** The API rejects a `compact_20260112` trigger below this many input tokens. */
export const ANTHROPIC_COMPACTION_MIN_TRIGGER_TOKENS = 50_000;

/**
 * Smallest context the native lane accepts. The trigger sits at the API
 * floor, so a prompt that lands below it is answered instead of compacted;
 * the margin over the floor absorbs the difference between the last reported
 * context size and the compaction request's own input.
 */
export const ANTHROPIC_COMPACTION_MIN_CONTEXT_TOKENS = 55_000;

/** Summary persisted under {@link ANTHROPIC_COMPACTION_PRESERVE_KEY}. */
export interface AnthropicCompactionPreserveData {
	provider: string;
	content: string;
	/** Model that wrote the summary. */
	model?: string;
	/** Prompt tokens the compaction request processed, for display. */
	usedTokens?: number;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

/**
 * Whether a model compacts through the Anthropic compaction beta: a model the
 * beta supports (the adaptive-thinking generation — Opus 4.6+, Sonnet 4.6+,
 * Fable/Mythos 5 — matches the documented model list; Haiku 4.5 and the
 * budget-thinking generations are rejected by the API) on an endpoint that
 * accepts it. Endpoint support is resolved the way the provider resolves the
 * request URL, so a Foundry or `ANTHROPIC_BASE_URL` reroute of a first-party
 * model is excluded unless the route opted in with `remoteCompaction.enabled`.
 */
export function shouldUseAnthropicNativeCompaction(model: Model): model is Model<"anthropic-messages"> {
	if (!isAnthropicMessagesModel(model)) return false;
	if (model.thinking?.mode !== "anthropic-adaptive") return false;
	return supportsAnthropicCompaction(model);
}

export function getPreservedAnthropicCompactionData(
	preserveData: Record<string, unknown> | undefined,
): AnthropicCompactionPreserveData | undefined {
	const candidate = preserveData?.[ANTHROPIC_COMPACTION_PRESERVE_KEY];
	if (!isRecord(candidate)) return undefined;
	if (typeof candidate.provider !== "string" || candidate.provider.length === 0) return undefined;
	if (typeof candidate.content !== "string" || candidate.content.length === 0) return undefined;
	return {
		provider: candidate.provider,
		content: candidate.content,
		...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
		...(typeof candidate.usedTokens === "number" ? { usedTokens: candidate.usedTokens } : {}),
	};
}

/** Set or strip the Anthropic compaction slot; a new compaction never inherits a stale summary. */
export function withAnthropicCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	compaction: AnthropicCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (compaction) {
		return { ...preserveData, [ANTHROPIC_COMPACTION_PRESERVE_KEY]: compaction };
	}
	if (!preserveData || !(ANTHROPIC_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}
	const { [ANTHROPIC_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Replay payload for a compaction summary the active model produced natively. */
export function getAnthropicCompactionPayload(
	preserveData: Record<string, unknown> | undefined,
): AnthropicCompactionPayload | undefined {
	const preserved = getPreservedAnthropicCompactionData(preserveData);
	if (!preserved) return undefined;
	return { type: "anthropicCompaction", provider: preserved.provider, content: preserved.content };
}

/**
 * The retained tail as the model will see it, for the summarization
 * instructions: how many of the conversation's final wire messages stay in
 * context verbatim, and the role of the first. The compaction request carries
 * the whole conversation so the prompt cache the live turn wrote is read, but
 * the summary must cover only the history before that tail — the local
 * summarizer never sees the tail, and the rebuilt context replays it after the
 * summary. Counting mirrors the provider's message conversion (consecutive
 * tool results collapse into one user message; developer messages are user
 * messages), and the description quotes no content: quoting the tail would
 * hand the summarizer the very facts it must leave to the tail.
 */
export function describeRetainedTail(messages: readonly Message[]): string | undefined {
	const first = messages[0];
	if (!first) return undefined;
	let count = 0;
	let previousWasToolResult = false;
	for (const message of messages) {
		const isToolResult = message.role === "toolResult";
		if (!(isToolResult && previousWasToolResult)) count += 1;
		previousWasToolResult = isToolResult;
	}
	const role = first.role === "assistant" ? "assistant" : "user";
	return count === 1
		? `final ${role} message stays`
		: `final ${count} messages, starting with a ${role} message, stay`;
}

/**
 * Summarization prompt sent as the edit's `instructions`, which replace the
 * API default entirely: the retained-tail boundary first, so the summary
 * covers only the history the rebuilt context drops, then the same structure
 * prompt as the local summarizer, the caller's focus, and the tool-abstention
 * clause the API recommends when tools are defined (a summarization pass that
 * calls a tool yields no summary).
 */
export function buildAnthropicCompactionInstructions(
	basePrompt: string,
	customInstructions: string | undefined,
	extraContext: string | undefined,
	retainedTail: string | undefined,
): string {
	const rendered = prompt.render(anthropicCompactionInstructionsPrompt, { retainedTail });
	const [scope, abstention] = rendered.split("\n\n---\n\n");
	const sections = [scope, extraContext, basePrompt];
	if (customInstructions) sections.push(`Additional focus: ${customInstructions}`);
	sections.push(abstention);
	return sections.filter((section): section is string => !!section && section.length > 0).join("\n\n");
}

export interface AnthropicNativeCompactionRequest {
	systemPrompt: string[];
	messages: Message[];
	tools?: Tool[];
	instructions: string;
	maxTokens: number;
	reasoning?: Effort;
}

export interface AnthropicNativeCompactionResponse {
	content: string;
	usage: Usage;
	model: string;
}

export interface AnthropicNativeCompactionOptions
	extends
		Pick<
			SimpleStreamOptions,
			| "initiatorOverride"
			| "metadata"
			| "fetch"
			| "sessionId"
			| "promptCacheKey"
			| "providerSessionState"
			| "maxInFlightRequests"
		>,
		Pick<InstrumentedChatSpanOptions, "completeImpl" | "telemetry" | "retry"> {}

/**
 * Run one compaction request and return the summary the API wrote. Throws
 * when the response is an error or carries no summary — the API answers the
 * prompt instead when its input never reached the trigger, and returns an
 * empty block when the model called a tool during summarization.
 */
export async function requestAnthropicNativeCompaction(
	model: Model<"anthropic-messages">,
	apiKey: ApiKey,
	request: AnthropicNativeCompactionRequest,
	signal: AbortSignal | undefined,
	options: AnthropicNativeCompactionOptions,
): Promise<AnthropicNativeCompactionResponse> {
	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools },
		{
			apiKey,
			signal,
			maxTokens: request.maxTokens,
			reasoning: request.reasoning,
			initiatorOverride: options.initiatorOverride,
			metadata: options.metadata,
			fetch: options.fetch,
			sessionId: options.sessionId,
			promptCacheKey: options.promptCacheKey,
			providerSessionState: options.providerSessionState,
			maxInFlightRequests: options.maxInFlightRequests,
			anthropicCompaction: {
				triggerInputTokens: ANTHROPIC_COMPACTION_MIN_TRIGGER_TOKENS,
				pauseAfterCompaction: true,
				instructions: request.instructions,
			},
		},
		{
			telemetry: options.telemetry,
			oneshotKind: "compaction_native",
			completeImpl: options.completeImpl,
			retry: options.retry,
		},
	);
	if (response.stopReason === "error") {
		throw new Error(`Anthropic compaction failed: ${response.errorMessage ?? "unknown error"}`);
	}
	const payload = response.providerPayload;
	if (payload?.type !== "anthropicCompaction" || payload.content.length === 0) {
		throw new Error(
			response.stopDetails?.type === "compaction"
				? "Anthropic compaction returned no summary"
				: "Anthropic compaction response carried no compaction block",
		);
	}
	return { content: payload.content, usage: response.usage, model: response.model };
}
