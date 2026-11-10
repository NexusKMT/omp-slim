import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelMention } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { parseEffort } from "@oh-my-pi/pi-tui/thinking";
import type { SessionEntry } from "./session-entries";

/** Legacy journal entry retained only for historical transcript display. */
export const MODEL_MENTION_ENTRY_TYPE = "model_mention";

/** Replay valid branch entries, keeping the first occurrence of each agent and selector. */
export function readModelMentions(entries: readonly SessionEntry[]): ModelMention[] {
	const mentions: ModelMention[] = [];
	const agents = new Set<string>();
	const selectors = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODEL_MENTION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { agent, selector, name, thinkingLevel } = entry.data;
		if (
			typeof agent !== "string" ||
			!/^m\d+$/.test(agent) ||
			typeof selector !== "string" ||
			typeof name !== "string" ||
			(thinkingLevel !== undefined &&
				(typeof thinkingLevel !== "string" ||
					parseEffort(thinkingLevel) !== thinkingLevel ||
					!selector.endsWith(`:${thinkingLevel}`)))
		)
			continue;
		if (agents.has(agent) || selectors.has(selector)) continue;
		agents.add(agent);
		selectors.add(selector);
		mentions.push({ agent, selector, name, thinkingLevel });
	}
	return mentions;
}
