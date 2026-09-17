/** Anchored `/cleanse` overlay rendering the host's live board above the editor. */
import { Spacer, Text, type TUI } from "../index";
import { SPINNER_FRAMES } from "../theme/symbols";
import type { AgentProgress } from "../tools/task";
import { replaceTabs } from "../render/render-utils";
import { theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";

const SPINNER_INTERVAL_MS = 80;
const MAX_LOG_LINES = 14;
const CLEANSE_SPINNER_FRAMES = SPINNER_FRAMES.unicode.activity;

export interface CleansePanelChecker {
	id: string;
	label: string;
}

export interface CleansePanelCheckResult extends CleansePanelChecker {
	diagnostics: readonly unknown[];
}

export interface CleansePanelAssignment {
	index: number;
	groups: readonly { file?: string }[];
}

export interface CleansePanelAgentOutcome {
	name: string;
	success: boolean;
	error?: string;
}

export type CleansePanelRunStatus = "clean" | "unresolved" | "unsupported" | "cancelled";

/** Host-owned live board state; finishing work returns its permanent log line. */
export interface CleansePanelModel {
	phase(text: string | undefined): void;
	checkerStarted(checker: CleansePanelChecker): void;
	checkerFinished(check: CleansePanelCheckResult, durationMs: number): string;
	repairFinished(): void;
	agentStarted(name: string, assignment: CleansePanelAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleansePanelAgentOutcome, assignment: CleansePanelAssignment): string;
	renderLive(spinner: string): readonly string[];
}

interface CleansePanelComponentOptions {
	model: CleansePanelModel;
	/** Free-form request shown in the header; omitted for checker-discovery runs. */
	request?: string;
	tui: TUI;
}

/** Terminal state of the run, mirrored into the footer once the core settles. */
type CleansePanelOutcome = CleansePanelRunStatus | "error";

export class CleansePanelComponent extends OverlayPanel {
	readonly interactive = true;

	readonly #tui: TUI;
	readonly #model: CleansePanelModel;
	readonly #logLines: string[] = [];
	#outcome: CleansePanelOutcome | undefined;
	#errorMessage: string | undefined;
	#frame = 0;
	#timer: NodeJS.Timeout | undefined;
	#liveClosed = false;

	constructor(options: CleansePanelComponentOptions) {
		super(options.request ? `/cleanse ${replaceTabs(options.request)}` : "/cleanse");
		this.#tui = options.tui;
		this.#model = options.model;
		this.#timer = setInterval(() => {
			this.#frame = (this.#frame + 1) % CLEANSE_SPINNER_FRAMES.length;
			this.#rebuild();
		}, SPINNER_INTERVAL_MS);
		this.#timer.unref?.();
		this.#rebuild();
	}

	log(text: string): void {
		this.#logLines.push(text);
		if (this.#logLines.length > MAX_LOG_LINES) this.#logLines.splice(0, this.#logLines.length - MAX_LOG_LINES);
		this.#rebuild();
	}

	/** Permanent line styled as a failure (the core's stderr-equivalent). */
	logError(text: string): void {
		this.log(theme.fg("error", text));
	}

	phase(text: string | undefined): void {
		this.#model.phase(text);
		this.#rebuild();
	}

	checkerStarted(checker: CleansePanelChecker): void {
		this.#model.checkerStarted(checker);
		this.#rebuild();
	}

	checkerFinished(check: CleansePanelCheckResult, durationMs: number): void {
		this.log(this.#model.checkerFinished(check, durationMs));
	}

	repairFinished(): void {
		this.#model.repairFinished();
		this.#rebuild();
	}

	agentStarted(name: string, assignment: CleansePanelAssignment): void {
		this.#model.agentStarted(name, assignment);
		this.#rebuild();
	}

	agentProgress(name: string, progress: AgentProgress): void {
		this.#model.agentProgress(name, progress);
	}

	agentFinished(outcome: CleansePanelAgentOutcome, assignment: CleansePanelAssignment): void {
		this.log(this.#model.agentFinished(outcome, assignment));
	}

	/** Stop the live area; the panel stays mounted until the user dismisses it. */
	close(): void {
		this.#liveClosed = true;
		this.#stopTimer();
		this.#rebuild();
	}

	/** Record the settled run result and switch the footer to its dismiss hint. */
	finish(status: CleansePanelRunStatus): void {
		this.#outcome = status;
		this.close();
	}

	/** Record an unexpected failure and switch the footer to its dismiss hint. */
	markError(message: string): void {
		this.#outcome = "error";
		this.#errorMessage = message;
		this.close();
	}

	/** Release the repaint timer during teardown. */
	override dispose(): void {
		this.#stopTimer();
		super.dispose();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		if (this.#logLines.length > 0) {
			for (const line of this.#logLines) this.addChild(new Text(replaceTabs(line), 0, 0));
			this.addChild(new Spacer(1));
		}
		if (!this.#liveClosed) {
			const liveLines = this.#model.renderLive(CLEANSE_SPINNER_FRAMES[this.#frame] ?? CLEANSE_SPINNER_FRAMES[0]);
			if (liveLines.length > 0) {
				for (const line of liveLines) this.addChild(new Text(replaceTabs(line), 0, 0));
				this.addChild(new Spacer(1));
			}
		}
		if (this.#errorMessage) {
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#errorMessage)), 0, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(this.#footerLine(), 0, 0));
		this.#tui.requestRender();
	}

	#footerLine(): string {
		switch (this.#outcome) {
			case undefined:
				return theme.fg("muted", "Esc cancel /cleanse");
			case "clean":
				return theme.fg("success", `${theme.status.success} Clean · Esc dismiss`);
			case "unresolved":
				return theme.fg("warning", `${theme.status.warning} Diagnostics remain · Esc dismiss`);
			case "unsupported":
				return theme.fg("warning", `${theme.status.warning} No runnable checker · Esc dismiss`);
			case "cancelled":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
		}
	}
}
