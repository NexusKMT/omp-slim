/**
 * Live status board for `omp cleanse`.
 *
 * Interactive terminals get a transient board repainted in place: a phase
 * spinner (model resolution, checker discovery), one row per running checker,
 * and one row per repair subagent showing its latest intent, current tool,
 * tool count, and elapsed time from {@link AgentProgress} snapshots. Finished
 * work is promoted to permanent scrollback lines as it settles.
 *
 * Non-TTY output keeps the original plain-line protocol
 * (`[start]`/`[done]`/`[fail]`), so scripted callers see unchanged output.
 */
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { createLiveBoard, type LiveBoardOutput } from "../cli/live-board";
import type { AgentProgress } from "../task/types";
import type { CleanseCheckerDescriptor } from "./checkers";
import type { CleanseAgentOutcome, CleanseAssignment, CleanseCheckResult } from "./types";

const BAR_WIDTH = 16;
const ACTIVITY_WIDTH = 96;
const ERROR_WIDTH = 300;

/** Rendering surface for one `omp cleanse` run. */
export interface CleanseStatusBoard {
	readonly interactive: boolean;
	/** Print a permanent line above the live area (plain write when non-TTY). */
	log(text: string): void;
	/** Show a transient spinner line; `undefined` clears it. Non-TTY prints the text once. */
	phase(text: string | undefined): void;
	checkerStarted(checker: CleanseCheckerDescriptor): void;
	checkerFinished(check: CleanseCheckResult, durationMs: number): void;
	/** Begin a repair wave of `total` subagents; resets the completion bar. */
	waveStarted(total: number): void;
	/** End the repair wave and drop its live rows. */
	waveFinished(): void;
	agentStarted(name: string, assignment: CleanseAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
	/** Clear the live area and restore the cursor. Idempotent. */
	close(): void;
}

interface RunningChecker {
	label: string;
	startedAt: number;
}

interface RunningAgent {
	assignment: CleanseAssignment;
	startedAt: number;
	progress?: AgentProgress;
}

/** Create the cleanse status board bound to `output` (default `process.stdout`). */
export function createCleanseStatusBoard(
	output: LiveBoardOutput = process.stdout,
	errors: LiveBoardOutput = process.stderr,
): CleanseStatusBoard {
	let phaseText: string | undefined;
	const checkers = new Map<string, RunningChecker>();
	const agents = new Map<string, RunningAgent>();
	/** Lifetime token/cost totals per agent; survives row removal for the header sums. */
	const totals = new Map<string, { tokens: number; cost: number }>();
	let waveTotal = 0;
	let waveDone = 0;
	let waveStartedAt = 0;

	const render = (spinner: string): string[] => {
		const lines: string[] = [];
		if (phaseText) lines.push(`${chalk.yellow(spinner)} ${phaseText}`);
		for (const checker of checkers.values()) {
			const elapsed = formatDuration(Date.now() - checker.startedAt);
			lines.push(`${chalk.yellow(spinner)} ${checker.label} ${chalk.dim(`· ${elapsed}`)}`);
		}
		if (waveTotal > 0) {
			lines.push(renderWaveHeader(spinner, waveTotal, waveDone, agents.size, totals, waveStartedAt));
			const rows = [...agents.entries()].sort((left, right) => left[1].assignment.index - right[1].assignment.index);
			for (const [name, agent] of rows) lines.push(renderAgentRow(spinner, name, agent));
		}
		return lines;
	};
	const board = createLiveBoard(render, output);

	return {
		interactive: board.interactive,
		log: board.log,
		phase(text) {
			if (!board.interactive) {
				if (text) output.write(`${text}\n`);
				return;
			}
			phaseText = text;
			board.repaint();
		},
		checkerStarted(checker) {
			if (!board.interactive) return;
			checkers.set(checker.id, { label: checker.label, startedAt: Date.now() });
			board.repaint();
		},
		checkerFinished(check, durationMs) {
			if (!board.interactive) return;
			checkers.delete(check.id);
			const count = check.diagnostics.length;
			const verdict = count === 0 ? chalk.green("clean") : chalk.yellow(`${count} issue${count === 1 ? "" : "s"}`);
			const glyph = count === 0 ? chalk.green("✓") : chalk.yellow("●");
			board.log(`${glyph} ${check.label} ${verdict} ${chalk.dim(`· ${formatDuration(durationMs)}`)}`);
		},
		waveStarted(total) {
			waveTotal = Math.max(total, 0);
			waveDone = 0;
			waveStartedAt = Date.now();
			agents.clear();
			totals.clear();
			board.repaint();
		},
		waveFinished() {
			waveTotal = 0;
			agents.clear();
			board.repaint();
		},
		agentStarted(name, assignment) {
			if (!board.interactive) {
				const files = assignment.groups.map(group => group.file ?? "<project>").join(", ");
				output.write(`[start] ${name}: ${files} (weight ${assignment.weight})\n`);
				return;
			}
			agents.set(name, { assignment, startedAt: Date.now() });
			board.repaint();
		},
		agentProgress(name, progress) {
			totals.set(name, { tokens: progress.tokens, cost: progress.cost });
			if (!board.interactive) return;
			const agent = agents.get(name);
			if (agent) agent.progress = progress;
		},
		agentFinished(outcome, assignment) {
			if (!board.interactive) {
				if (outcome.success) {
					output.write(`[done] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
				} else {
					errors.write(`[fail] ${outcome.name}: ${oneLine(outcome.error ?? "subagent failed", ERROR_WIDTH)}\n`);
				}
				return;
			}
			const agent = agents.get(outcome.name);
			agents.delete(outcome.name);
			waveDone = Math.min(waveDone + 1, waveTotal);
			board.log(renderOutcomeLine(outcome, assignment, agent, totals.get(outcome.name)));
		},
		close: board.close,
	};
}

function renderWaveHeader(
	spinner: string,
	total: number,
	done: number,
	running: number,
	totals: ReadonlyMap<string, { tokens: number; cost: number }>,
	startedAt: number,
): string {
	const filled = Math.round(Math.min(done / total, 1) * BAR_WIDTH);
	const bar = chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(BAR_WIDTH - filled));
	let tokens = 0;
	let cost = 0;
	for (const entry of totals.values()) {
		tokens += entry.tokens;
		cost += entry.cost;
	}
	const parts = [`${done}/${total}`];
	if (running > 0) parts.push(`${running} running`);
	if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
	if (cost > 0) parts.push(formatCost(cost));
	parts.push(formatDuration(Date.now() - startedAt));
	return `${chalk.cyan(spinner)} Repairing [${bar}] ${parts.join(chalk.dim(" · "))}`;
}

function renderAgentRow(spinner: string, agentName: string, agent: RunningAgent): string {
	const label = agentName.replace(/^Cleanse/, "");
	const meta: string[] = [];
	const toolCount = agent.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	meta.push(formatDuration(Date.now() - agent.startedAt));
	return (
		`${chalk.yellow(spinner)} ${chalk.bold(label)} ${compactFiles(agent.assignment)} ` +
		`${chalk.dim("·")} ${agentActivity(agent.progress)} ${chalk.dim(`· ${meta.join(" · ")}`)}`
	);
}

function renderOutcomeLine(
	outcome: CleanseAgentOutcome,
	assignment: CleanseAssignment,
	agent: RunningAgent | undefined,
	total: { tokens: number; cost: number } | undefined,
): string {
	const files = compactFiles(assignment);
	if (!outcome.success) {
		return `${chalk.red("✗")} ${outcome.name} ${files} ${chalk.red(oneLine(outcome.error ?? "subagent failed", ERROR_WIDTH))}`;
	}
	const meta: string[] = [];
	const toolCount = agent?.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	if (total && total.tokens > 0) meta.push(`${formatNumber(total.tokens)} tok`);
	if (agent) meta.push(formatDuration(Date.now() - agent.startedAt));
	const suffix = meta.length > 0 ? ` ${chalk.dim(`· ${meta.join(" · ")}`)}` : "";
	return `${chalk.green("✓")} ${outcome.name} ${files}${suffix}`;
}

/** Latest human-readable activity for a repair agent row. */
function agentActivity(progress: AgentProgress | undefined): string {
	if (!progress) return chalk.dim("starting");
	if (progress.retryState) {
		return chalk.yellow(`rate-limited · retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`);
	}
	const intent = oneLine(progress.lastIntent ?? "", ACTIVITY_WIDTH);
	if (progress.currentTool) {
		const args = oneLine(progress.currentToolArgs ?? "", ACTIVITY_WIDTH);
		const tool = chalk.dim(args ? `${progress.currentTool} ${args}` : progress.currentTool);
		return intent ? `${intent} ${tool}` : tool;
	}
	return intent || chalk.dim("thinking");
}

function compactFiles(assignment: CleanseAssignment): string {
	const files = assignment.groups.map(group => group.file ?? "<project>");
	const first = files[0] ?? "<project>";
	return files.length > 1 ? `${first} +${files.length - 1}` : first;
}

function oneLine(text: string, width: number): string {
	return sanitizeText(text).replace(/\s+/g, " ").trim().slice(0, width);
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}
