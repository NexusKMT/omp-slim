/**
 * Idle maintenance owned by one session: idle compaction that runs once the
 * session has been quiet for a while and its owner does not hold it back.
 *
 * Idle compaction waits until no background job or delivery can wake the
 * session. New activity, compaction, a session transition or disposal invalidates everything
 * captured before it: timers and the settling check.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { combine } from "../config/registry";
import type { AgentSession } from "./agent-session";
import type { AgentSessionEvent } from "./agent-session-events";
import {
	cfgCompactionIdleEnabled,
	cfgCompactionIdleThresholdTokens,
	cfgCompactionIdleTimeoutSeconds,
} from "./context-settings";
import { isSessionSettled, type SessionSettleHost, waitForSessionSettlement } from "./session-settle";

/** Probes the owner of the session supplies. Both are re-read whenever work could start. */
export interface IdleMaintenanceOptions {
	/** True while the owner does not want autonomous work (a draft being composed, the view left, startup unfinished). */
	isBlocked?: () => boolean;
	/** True while the owner has decided to start a turn it has not yet admitted (for example a scheduled goal continuation). */
	scheduledTurn?: () => boolean;
}

/** The session surface idle maintenance reads and drives. */
export type IdleMaintenanceSession = SessionSettleHost &
	Pick<
		AgentSession,
		| "settings"
		| "sessionManager"
		| "isCompacting"
		| "isSessionTransitioning"
		| "subscribe"
		| "waitForIdle"
		| "waitForAdmittedSubmissions"
		| "getContextUsage"
		| "runIdleCompaction"
	>;

const COMPACTION_MIN_SECONDS = 60;
const COMPACTION_MAX_SECONDS = 3600;

/** Only the idle-compaction inputs: unrelated `compaction.*` changes must not restart a deadline. */
const cfgIdleCompaction = combine({
	enabled: cfgCompactionIdleEnabled,
	thresholdTokens: cfgCompactionIdleThresholdTokens,
	timeoutSeconds: cfgCompactionIdleTimeoutSeconds,
});

/** Work the current stretch of activity still owes; drops once compaction has been done. */
interface PendingStretch {
	compaction: boolean;
}

export class IdleMaintenance {
	readonly #session: IdleMaintenanceSession;
	readonly #options: IdleMaintenanceOptions;
	readonly #stops: Array<() => void>;
	#pending: PendingStretch | undefined;
	/** Bumped to supersede the settling check that will arm this stretch. */
	#check = 0;
	#compactionTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(session: IdleMaintenanceSession, options: IdleMaintenanceOptions = {}) {
		this.#session = session;
		this.#options = options;
		this.#stops = [
			session.subscribe(event => this.#observe(event)),
			cfgIdleCompaction.listen(session.settings, () => this.refresh()),
		];
	}

	/**
	 * The owner's inputs may have changed (a setting, the blocker, a scheduled turn that went away): drop
	 * work that is no longer wanted and re-arm whatever the current stretch still owes, with a fresh delay.
	 */
	refresh(): void {
		if (this.#disposed || !this.#pending) return;
		this.#schedule();
	}

	/**
	 * Supersede the current stretch: nothing captured before this call may arm or record
	 * afterwards. Called on new activity, maintenance, at the start of every session transition and on disposal.
	 */
	invalidate(): void {
		this.#pending = undefined;
		this.#clearTimers();
		this.#check++;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.invalidate();
		for (const stop of this.#stops.splice(0)) stop();
	}

	#observe(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "auto_compaction_start":
			case "auto_compaction_end":
				this.invalidate();
				break;
			case "agent_end":
				this.invalidate();
				this.#pending = { compaction: true };
				this.#schedule();
				break;
		}
	}

	#clearTimers(): void {
		clearTimeout(this.#compactionTimer);
		this.#compactionTimer = undefined;
	}

	/** Compaction or a session transition is under way, or the owner does not want autonomous work. */
	#isBlocked(): boolean {
		const session = this.#session;
		return this.#options.isBlocked?.() === true || session.isCompacting || session.isSessionTransitioning;
	}

	/**
	 * Nothing is live, admitted, queued or scheduled. Background work may still wake the session;
	 * idle compaction additionally requires {@link #isSettled}.
	 */
	#isQuiet(): boolean {
		const session = this.#session;
		return (
			!session.isStreaming &&
			!session.hasAdmittedSubmission &&
			session.queuedMessageCount === 0 &&
			this.#options.scheduledTurn?.() !== true
		);
	}

	/** Quiet, and no background job or delivery can wake the session. */
	#isSettled(): boolean {
		return isSessionSettled(this.#session, this.#options.scheduledTurn);
	}

	#contextTokens(): number {
		return this.#session.getContextUsage()?.tokens ?? 0;
	}

	/**
	 * Restart the settling check for the current stretch, replacing any earlier one and the armed timers.
	 * The check is launched off the caller's stack: the terminal `agent_end` is published while its own
	 * prompt is still admitted, so it must wait for the authoritative barriers before judging the session.
	 */
	#schedule(): void {
		this.#clearTimers();
		const check = ++this.#check;
		if (this.#disposed || !this.#pending) return;
		void this.#armWhenQuiet(() => this.#check === check).catch(error =>
			logger.warn("Idle maintenance check failed", { error: String(error) }),
		);
	}

	async #armWhenQuiet(isCurrent: () => boolean): Promise<void> {
		const session = this.#session;
		for (;;) {
			await session.waitForIdle();
			if (!isCurrent()) return;
			if (!session.hasAdmittedSubmission) break;
			await session.waitForAdmittedSubmissions();
			if (!isCurrent()) return;
		}
		if (this.#isBlocked() || !this.#isQuiet()) return;
		const settled = await waitForSessionSettlement(session, {
			isCurrent,
			scheduledTurn: this.#options.scheduledTurn,
		});
		if (!settled || this.#isBlocked()) return;
		this.#armCompaction();
	}

	/** Start the idle compaction delay, if this settled stretch still owes it and the context is over the threshold. */
	#armCompaction(): void {
		if (!this.#pending?.compaction) return;
		const idle = cfgIdleCompaction.get(this.#session.settings);
		if (idle.enabled && idle.thresholdTokens > 0 && this.#contextTokens() >= idle.thresholdTokens) {
			this.#compactionTimer = setTimeout(
				() => this.#onCompactionDue(),
				this.#compactionDelayMs(idle.timeoutSeconds),
			);
			this.#compactionTimer.unref?.();
		}
	}

	#compactionDelayMs(timeoutSeconds: number): number {
		return Math.max(COMPACTION_MIN_SECONDS, Math.min(COMPACTION_MAX_SECONDS, timeoutSeconds)) * 1000;
	}

	#onCompactionDue(): void {
		this.#compactionTimer = undefined;
		const pending = this.#pending;
		if (!pending?.compaction) return;
		if (this.#isBlocked()) return;
		if (!this.#isSettled()) {
			this.#schedule();
			return;
		}
		const idle = cfgIdleCompaction.get(this.#session.settings);
		if (!idle.enabled || idle.thresholdTokens <= 0 || this.#contextTokens() < idle.thresholdTokens) {
			return;
		}
		this.#complete(pending);
		this.#session.runIdleCompaction().catch(error => logger.warn("Idle compaction failed", { error: String(error) }));
	}

	#complete(pending: PendingStretch): void {
		pending.compaction = false;
		if (this.#pending !== pending) return;
		this.#pending = undefined;
		this.#check++;
	}
}
