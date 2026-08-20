import { getProjectDir } from "@oh-my-pi/pi-utils";
import { pickCleanseTarget, promptCleanseRequest } from "../cli/cleanse-picker";
import { shortenPath } from "../tools/render-utils";
import { type CleanseAgentHooks, type CleanseAgentRuntime, createCleanseAgentRuntime } from "./agent";
import { groupDiagnosticsByFile } from "./balance";
import { createCleanseStatusBoard } from "./board";
import {
	buildCustomCleanseSuite,
	type CleanseCheckerRunEvents,
	type CleanseDiagnosticSuite,
	discoverCleanseDiagnosticSuite,
} from "./checkers";
import { runCleanseLoop } from "./loop";
import type { CleanseDiagnosticReport, CleanseLoopResult } from "./types";

const DEFAULT_MODEL = "@smol";
const DISPLAY_FILE_LIMIT = 50;

/** User-facing options for `omp cleanse`. */
export interface CleanseCommandOptions {
	maxAgents?: number;
	model?: string;
	includeTests?: boolean;
	/** Free-form description handed to a discovery agent instead of built-in checker discovery. */
	request?: string;
	/** Run every discovered checker without the interactive picker. */
	all?: boolean;
}

/** Observable completion state returned to the CLI adapter. */
export interface CleanseCommandResult {
	exitCode: number;
	status: "clean" | "unresolved" | "unsupported" | "cancelled";
	report: CleanseDiagnosticReport;
	sessionFile?: string;
}

/** Detect project diagnostics, dispatch one bounded repair batch, and verify it. */
export async function runCleanseCommand(options: CleanseCommandOptions = {}): Promise<CleanseCommandResult> {
	const maxAgents = options.maxAgents ?? 32;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error("--agents must be a positive integer");
	const model = options.model?.trim() || DEFAULT_MODEL;
	const cwd = getProjectDir();
	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error("Cleanse interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let runtime: CleanseAgentRuntime | undefined;
	let loopResult: CleanseLoopResult | undefined;
	const board = createCleanseStatusBoard();
	const hooks: CleanseAgentHooks = {
		onStart: (name, assignment) => board.agentStarted(name, assignment),
		onProgress: (name, _assignment, progress) => board.agentProgress(name, progress),
		onFinish: (outcome, assignment) => board.agentFinished(outcome, assignment),
	};
	const checkerEvents: CleanseCheckerRunEvents = {
		onCheckerStart: checker => board.checkerStarted(checker),
		onCheckerEnd: (check, durationMs) => board.checkerFinished(check, durationMs),
	};
	const ensureRuntime = async (): Promise<CleanseAgentRuntime> => {
		if (runtime) return runtime;
		board.phase(`Resolving model ${model}...`);
		try {
			runtime = await createCleanseAgentRuntime({ cwd, model, hooks });
		} finally {
			board.phase(undefined);
		}
		board.log(`Model: ${runtime.model}`);
		board.log(`Session: ${shortenPath(runtime.sessionFile)}`);
		return runtime;
	};

	try {
		let request = options.request?.trim() || undefined;
		let suite: CleanseDiagnosticSuite | undefined;
		if (!request) {
			board.phase("Detecting configured project checkers...");
			suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
			board.phase(undefined);
			const interactive = options.all !== true && process.stdin.isTTY === true && process.stdout.isTTY === true;
			if (interactive) {
				if (suite.checkers.length > 0) {
					const choice = await pickCleanseTarget(suite.checkers);
					if (choice.kind === "cancel") {
						process.stderr.write("Cleanse cancelled.\n");
						return {
							exitCode: 130,
							status: "cancelled",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					if (choice.kind === "checker") suite.select([choice.id]);
					if (choice.kind === "request") {
						request = choice.request;
						suite = undefined;
					}
				} else {
					printSkippedChecks({ checks: [], diagnostics: [], skipped: [...suite.skipped] });
					process.stdout.write("No supported checker with an available executable was found.\n");
					const answer = await promptCleanseRequest();
					if (answer === null) {
						return {
							exitCode: 1,
							status: "unsupported",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					request = answer;
					suite = undefined;
				}
			}
		}
		if (request) {
			const activeRuntime = await ensureRuntime();
			board.phase(`Discovering checkers for "${request}"...`);
			try {
				const specs = await activeRuntime.discoverCheckers(request, abortController.signal);
				suite = await buildCustomCleanseSuite(cwd, specs);
			} finally {
				board.phase(undefined);
			}
			for (const checker of suite.checkers) {
				board.log(`[checker] ${checker.label}: ${checker.command}`);
			}
		}
		if (!suite || suite.checkers.length === 0) {
			const report: CleanseDiagnosticReport = { checks: [], diagnostics: [], skipped: [...(suite?.skipped ?? [])] };
			printSkippedChecks(report);
			process.stderr.write(
				request
					? "Checker discovery produced no runnable command.\n"
					: "No supported checker with an available executable was found.\n",
			);
			return { exitCode: 1, status: "unsupported", report, sessionFile: runtime?.sessionFile };
		}
		const initialReport = await suite.run(abortController.signal, checkerEvents);
		if (board.interactive) printSkippedChecks(initialReport);
		else printCheckReport(initialReport);
		if (initialReport.diagnostics.length === 0) {
			process.stdout.write(
				`Clean: ${initialReport.checks.length} checker${initialReport.checks.length === 1 ? "" : "s"} passed.\n`,
			);
			return { exitCode: 0, status: "clean", report: initialReport, sessionFile: runtime?.sessionFile };
		}

		const assignments = groupDiagnosticsByFile(initialReport.diagnostics);
		const agentCount = Math.min(maxAgents, assignments.length);
		const fileCount = assignments.filter(group => group.file !== undefined).length;
		board.log(
			`Found ${initialReport.diagnostics.length} diagnostic${initialReport.diagnostics.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}; launching ${agentCount} subagent${agentCount === 1 ? "" : "s"}.`,
		);
		const activeRuntime = await ensureRuntime();
		const activeSuite = suite;
		loopResult = await runCleanseLoop(
			{ maxAgents, initialReport, signal: abortController.signal },
			{
				collect: signal => activeSuite.run(signal, checkerEvents),
				dispatch: (batch, wave, report, signal) => activeRuntime.dispatch(batch, wave, report, signal),
				onWave(_wave, batch) {
					board.log(`Dispatching ${batch.length} weighted assignment${batch.length === 1 ? "" : "s"}...`);
					board.waveStarted(batch.length);
				},
				onReport(_wave, report) {
					board.waveFinished();
					board.log(
						`Verification: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"} remaining.`,
					);
				},
			},
		);
		board.close();
		await activeRuntime.close(loopResult);
		if (loopResult.status === "cancelled") {
			process.stderr.write("Cleanse cancelled.\n");
			return {
				exitCode: 130,
				status: "cancelled",
				report: loopResult.report,
				sessionFile: activeRuntime.sessionFile,
			};
		}
		if (loopResult.status === "clean") {
			process.stdout.write("Clean: all detected diagnostics are resolved.\n");
			return { exitCode: 0, status: "clean", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
		}
		printRemaining(loopResult.report);
		return { exitCode: 1, status: "unresolved", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
	} catch (error) {
		if (!abortController.signal.aborted) throw error;
		const report: CleanseDiagnosticReport = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
		board.close();
		process.stderr.write("Cleanse cancelled.\n");
		return { exitCode: 130, status: "cancelled", report, sessionFile: runtime?.sessionFile };
	} finally {
		board.close();
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		await runtime?.close(loopResult);
	}
}

function printCheckReport(report: CleanseDiagnosticReport): void {
	for (const check of report.checks) {
		const count = check.diagnostics.length;
		process.stdout.write(`- ${check.label}: ${count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`}\n`);
	}
	printSkippedChecks(report);
}

function printSkippedChecks(report: CleanseDiagnosticReport): void {
	for (const skipped of report.skipped) {
		process.stdout.write(`- ${skipped.label}: skipped (${skipped.reason})\n`);
	}
}

function printRemaining(report: CleanseDiagnosticReport): void {
	const groups = groupDiagnosticsByFile(report.diagnostics);
	process.stderr.write(
		`Unresolved: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? "" : "s"}.\n`,
	);
	for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) {
		process.stderr.write(`- ${group.file ?? "<project>"}: ${group.diagnostics.length}\n`);
	}
	if (groups.length > DISPLAY_FILE_LIMIT) {
		process.stderr.write(`- ... ${groups.length - DISPLAY_FILE_LIMIT} more files\n`);
	}
}
