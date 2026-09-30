import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { ToolCall } from "../types";

/** Final arguments must not reuse the streaming parser's auto-closed preview. */
export function parseToolCallArguments(json: string | undefined): ToolCall["arguments"] {
	// Some providers omit arguments entirely for zero-argument tools.
	if (!json?.trim()) return {};
	try {
		return parseJsonWithRepair<ToolCall["arguments"]>(json);
	} catch (error) {
		return invalidToolCallArguments(json, error);
	}
}

/** Preserve a bounded diagnostic, never any partially recovered executable keys. */
export function invalidToolCallArguments(raw: string, error: unknown): ToolCall["arguments"] {
	const maxLen = 512;
	return {
		__parseError: error instanceof Error ? error.message : String(error),
		__rawJson: raw.length <= maxLen ? raw : `${raw.slice(0, maxLen)}… [truncated ${raw.length - maxLen} chars]`,
	};
}
