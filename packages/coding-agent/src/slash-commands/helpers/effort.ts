import type { AgentSession } from "../../session/agent-session";
import { type ConfiguredThinkingLevel, parseCliThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/**
 * Effort selectors `/thinking` accepts for the session's active model. `off` and
 * `auto` are always selectable; the concrete tiers are the ones this model
 * actually exposes, so neither the handler nor autocomplete offers a level the
 * clamp would silently rewrite. Empty when the model has no reasoning dial at
 * all.
 *
 * Shared by the handler's `choices` check and the TUI argument completions so
 * the dropdown can never suggest a value the handler then rejects.
 */
export function availableEffortSelectors(session: AgentSession): ConfiguredThinkingLevel[] {
	return session.getAvailableEffortSelectors();
}

/** Text shown when the active model has no thinking dial. */
export function noThinkingMessage(session: AgentSession): string {
	const model = session.model;
	return `${model ? `${model.provider}/${model.id}` : "The current model"} has no adjustable thinking level.`;
}

/**
 * Resolve a `/thinking <level>` argument to a selector the active model
 * accepts, or the message explaining why it cannot be applied. Shared by the
 * text/ACP handler and the TUI handler.
 */
export function resolveThinkingArgument(
	session: AgentSession,
	args: string,
): { level: ConfiguredThinkingLevel } | { error: string } {
	if (!session.model?.reasoning) return { error: noThinkingMessage(session) };
	const choices = availableEffortSelectors(session);
	const selector = args.trim().toLowerCase();
	const parsed = parseCliThinkingLevel(selector);
	if (parsed === undefined || !choices.includes(parsed)) {
		return { error: `Unknown thinking level: ${selector}. Available: ${choices.join(", ")}` };
	}
	return { level: parsed };
}
