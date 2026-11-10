import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/** Detects terminal turns eligible for mechanical recovery. */
export function isUnexpectedStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	let hasContent = false;
	for (const content of message.content) {
		// A tool call or image is deliverable output; retrying would repeat it.
		if (content.type === "toolCall" || content.type === "image") return false;
		if (content.type === "text" && /\S/.test(content.text)) {
			hasContent = true;
		}
		// A signed thinking-only stop is still a candidate: reasoning models can
		// trap the intended response (or a truncated fragment) in a thinking block
		// with no text, or end on a signature-only block whose reasoning text was
		// withheld. #isEmptyAssistantStop treats a non-whitespace signature as
		// terminal (not empty), so such stops bypass the empty-stop path entirely.
		// Match that predicate here — unsigned thinking-only stops stay with the
		// empty-stop retry path (and its cap) rather than being re-handled here.
		if (content.type === "thinking" && /\S/.test(content.thinkingSignature ?? "")) {
			hasContent = true;
		}
	}
	return hasContent;
}
