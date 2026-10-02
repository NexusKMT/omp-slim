/**
 * Periodic completion self-estimates for running subagents.
 *
 * Every `task.completionProbeMs` the subagent is asked, through the same
 * ephemeral side turn `/btw` uses ({@link AgentSession.runEphemeralTurn}), to
 * estimate how complete its task is. The side turn reuses the live session's
 * system prompt, tools and history, so it reads the main conversation's prompt
 * cache and never touches the transcript. The parsed percentage feeds
 * `AgentProgress.completionPercent`, which wait/task views render.
 */
import { logger } from "@oh-my-pi/pi-utils";
import completionProbePrompt from "../prompts/system/subagent-completion-probe.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";

/** Inputs for {@link startCompletionProbe}. */
export interface CompletionProbeOptions {
	/** Probe period; values ≤ 0 disable probing. */
	intervalMs: number;
	/** The run's current session; probing skips ticks while it is absent or idle. */
	session: () => AgentSession | null;
	/** Stops the timer and cancels an in-flight probe. */
	signal: AbortSignal;
	/** Receives each parsed estimate with the side request's cost in USD. */
	onEstimate: (percent: number, cost: number) => void;
}

/**
 * Extract a 0–100 percentage from a probe reply (`"40%"`, `"~65 %"`, `"Roughly 70%."`).
 * Returns `undefined` when the reply carries no percentage.
 */
export function parseCompletionPercent(reply: string): number | undefined {
	const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(reply);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Probe the run's session every {@link CompletionProbeOptions.intervalMs} until
 * `signal` aborts. Ticks are skipped while the session is idle or a previous
 * probe is still in flight; failures are logged and the next tick retries.
 */
export function startCompletionProbe(options: CompletionProbeOptions): void {
	const { intervalMs, signal } = options;
	if (intervalMs <= 0 || signal.aborted) return;
	let inFlight = false;
	const probe = async (): Promise<void> => {
		const session = options.session();
		if (inFlight || !session?.isStreaming || signal.aborted) return;
		inFlight = true;
		try {
			const { replyText, assistantMessage } = await session.runEphemeralTurn({
				promptText: completionProbePrompt,
				signal,
			});
			const percent = parseCompletionPercent(replyText);
			if (signal.aborted) return;
			if (percent === undefined) {
				logger.debug("Subagent completion probe reply had no percentage", { reply: replyText.slice(0, 200) });
				return;
			}
			options.onEstimate(percent, assistantMessage.usage?.cost?.total ?? 0);
		} catch (error) {
			if (!signal.aborted) {
				logger.debug("Subagent completion probe failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			inFlight = false;
		}
	};
	const timer = setInterval(() => void probe(), intervalMs);
	timer.unref?.();
	signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
