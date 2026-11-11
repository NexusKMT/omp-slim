/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

/**
 * Marks an Anthropic wire message that was serialized from a source
 * `role: "user"` message.
 *
 * The wire role alone cannot answer this. `convertAnthropicMessages` emits
 * `role: "user"` for several things that are not a conversational turn:
 * `developer` messages on models without mid-conversation `system` support,
 * `tool_result` runs, and the synthetic `Continue.` pads inserted between
 * adjacent assistants. Prompt-cache decimation counts conversational turns,
 * so it reads this marker instead of guessing from wire content.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kConversationalUser = Symbol("provider.message.conversationalUser");

/** Carries the conversational-user marker without exposing a string-keyed property. */
export type ConversationalUserCarrier = object & { [kConversationalUser]?: boolean };

/** True for wire messages serialized from a source `role: "user"` message. */
export function isConversationalUser(message: ConversationalUserCarrier | null | undefined): boolean {
	return message?.[kConversationalUser] === true;
}

/**
 * Marks a `role: "user"` message that `transformMessages` synthesized rather
 * than one the user sent.
 *
 * The stale-tool-result note is deliberately emitted as `user` so no provider
 * elevates untrusted tool output to instruction priority, which leaves it
 * indistinguishable from a real turn by role alone. Prompt-cache decimation
 * must not count it, or an orphan result appearing or disappearing in a
 * compacted history shifts every later checkpoint.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kSyntheticUser = Symbol("provider.message.syntheticUser");

/** Carries the synthetic-user marker without exposing a string-keyed property. */
export type SyntheticUserCarrier = object & { [kSyntheticUser]?: boolean };

/** True for `user` messages synthesized by message transformation. */
export function isSyntheticUser(message: SyntheticUserCarrier | null | undefined): boolean {
	return message?.[kSyntheticUser] === true;
}

/**
 * Marks a message synthesized by a per-call context transform rather than
 * loaded from persisted conversation history.
 *
 * Prompt-cache boundaries must skip these messages: their content is rebuilt
 * for each request and cannot anchor a prefix reused by the next turn.
 * Symbol-keyed so the marker never persists or reaches the provider wire.
 */
export const kPerCallContextMessage = Symbol("agent.message.perCallContext");

/** Carries per-call context provenance without exposing a string-keyed property. */
export type PerCallContextMessageCarrier = object & { [kPerCallContextMessage]?: true };

/** Marks a message as synthesized for the current provider call. */
export function markPerCallContextMessage(message: PerCallContextMessageCarrier): void {
	message[kPerCallContextMessage] = true;
}

/** Copies per-call context provenance to a converted or projected message. */
export function copyPerCallContextMessage(
	target: PerCallContextMessageCarrier,
	source: PerCallContextMessageCarrier,
): void {
	if (source[kPerCallContextMessage] === true) target[kPerCallContextMessage] = true;
}

/** True when a message was synthesized for the current provider call. */
export function isPerCallContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] === true;
}

/**
 * Original history position carried by a context message clone.
 *
 * Object-spread transforms retain this symbol, allowing the extension runner
 * to distinguish byte-identical historical copies from inserted messages.
 */
export const kContextHistoryIndex = Symbol("agent.message.contextHistoryIndex");

/** Carries a context message's original history position. */
export type ContextHistoryIndexCarrier = object & { [kContextHistoryIndex]?: number };

/** Reads a context message's original history position. */
export function getContextHistoryIndex(message: ContextHistoryIndexCarrier | null | undefined): number | undefined {
	return message?.[kContextHistoryIndex];
}

/** Records a context message's original history position. */
export function setContextHistoryIndex(message: ContextHistoryIndexCarrier, index: number): void {
	message[kContextHistoryIndex] = index;
}

/** Removes context-history tracking before provider conversion. */
export function clearContextHistoryIndex(message: ContextHistoryIndexCarrier): void {
	delete message[kContextHistoryIndex];
}
