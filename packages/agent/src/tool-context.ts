import type { AgentMessage } from "./types";

/**
 * True for a passive-context value worth delivering: a string with at least
 * one non-whitespace character. Shared by every producer and aggregation site
 * so blank values never produce a developer message.
 */
export function isNonBlankContext(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Join passive context values in order, dropping blanks and repeats of an
 * earlier value (compared without surrounding whitespace; the first original
 * is kept). Returns undefined when nothing remains.
 */
export function joinAdditionalContext(values: Iterable<string | undefined>): string | undefined {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const value of values) {
		if (!isNonBlankContext(value)) continue;
		const key = value.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(value);
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}

/**
 * Build the developer message that carries passive tool context to the next
 * provider request. Emitted after the tool results it belongs to.
 */
export function createAdditionalContextMessage(text: string): AgentMessage {
	return {
		role: "developer",
		content: [{ type: "text", text }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}
