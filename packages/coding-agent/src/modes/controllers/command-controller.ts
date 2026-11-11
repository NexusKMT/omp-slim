import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { type Model } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Loader,
	Markdown,
	parseSgrMouse,
	Spacer,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatDuration, logger, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getConfigDirName } from "@oh-my-pi/pi-utils/dirs";
import { classifyTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import type { CompactOptions } from "../../extensibility/extensions/types";
import { BashExecutionComponent, bashPtyViewport } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";

import { messageBlock, PresentedBlock } from "@oh-my-pi/pi-tui/chat/transcript-presentation";
import { MoveOverlay, type MoveOverlayResult } from "@oh-my-pi/pi-tui/overlays/move-overlay";
import { moveDirectorySource } from "../move-directory-source";
import { getMarkdownTheme, getSymbolTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { continuesConversation } from "../utils/conversation-position";
import { ContextViewer } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import type { TspText } from "@oh-my-pi/pi-wire";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { buildSessionContextView } from "../../session/context-view";
import { buildHotkeysMarkdown, HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { buildToolsMarkdown } from "@oh-my-pi/pi-tui/prompt/tools-markdown";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";

import type { CompactMode } from "../../session/compact-modes";
import {
	currentRuntimeIdentity,
	formatRuntimeIdentity,
	runtimeIdentityHistory,
	sameRuntimeIdentity,
} from "../../session/runtime-identity";
import type { NewSessionOptions } from "../../session/session-entries";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../../session/session-worktree";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";

import { resolveTernPane } from "../../utils/tern/kind";
import { TernError, type TernErrorKind, TernSocketClient } from "../../utils/tern/wire";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import { replaceTabs, shortenEmbeddedPaths } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDumpArchiveReport, type SessionDumpArchive } from "../../session/session-dump-format";
import { openPath } from "../../utils/open";
import { resumeCommand } from "../../utils/resume-command";
import { setSessionTerminalTitle } from "../../utils/title-generator";

import { cfgTerminalShowImages } from "../settings";
import { cfgProviderAppendOnlyContext } from "../../session/settings";
import { flagConsumesValue, restartArgv } from "../../cli/flag-tables";
import {
	createDefaultTerminalLaunchRequest,
	getTerminalLaunchPlacement,
	launchTerminal,
	TerminalLaunchError,
	type TerminalLaunchRequest,
	type TerminalLaunchResult,
} from "../../subprocess/terminal-launch";
import { resolveCliEntryCmd } from "../../subprocess/worker-client";

/** How long `/fork` waits for Tern to open the fork's pane. */
const TERN_FORK_TIMEOUT_MS = 10_000;

/** Fork failures after which Tern may still open the pane, so `/fork` must not also fork in place. */
const TERN_FORK_UNCONFIRMED: Partial<Record<TernErrorKind, true>> = { closed: true, timeout: true, protocol: true };

/** Rows `/session` spends on the builds that wrote the session, including the elision row. */
const MAX_LISTED_BUILDS = 5;

function formatCreditValue(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

interface ForkTerminalDependencies {
	classifyTerminalMultiplexer: typeof classifyTerminalMultiplexer;
	environment: () => NodeJS.ProcessEnv;
	launchTerminal: (request: TerminalLaunchRequest) => Promise<TerminalLaunchResult>;
	resolveCliEntryCmd: typeof resolveCliEntryCmd;
	getActiveProfile: typeof getActiveProfile;
	argv: () => string[];
}

/**
 * Startup flags the fork child re-supplies from the parent's live state
 * (`--profile`, `--model`, `--thinking`, `--prompt-cache-key`) or that would
 * re-point it at a stale scope (`--config`/`--cwd`/`--provider`; the child
 * gets the effective overlays via `PI_CONFIG_FILES` and the session cwd).
 */
const FORK_LAUNCH_OVERRIDES: Readonly<Record<string, true>> = {
	"--config": true,
	"--cwd": true,
	"--model": true,
	"--profile": true,
	"--prompt-cache-key": true,
	"--provider": true,
	"--thinking": true,
};

/**
 * `env` prefix pinning each scope variable for the fork child. Multiplexer
 * servers keep stale environment snapshots, so every variable is pinned:
 * defined values are assigned, absent (or empty) ones are unset with `-u`
 * (which must precede the assignments) rather than exported as empty strings
 * that `??`-style consumers would treat as a set, relative path.
 */
function forkScopeEnvCommand(scope: Readonly<Record<string, string | undefined>>): string[] {
	const unset: string[] = [];
	const assignments: string[] = [];
	for (const [name, value] of Object.entries(scope)) {
		if (value) assignments.push(`${name}=${value}`);
		else unset.push("-u", name);
	}
	return ["env", ...unset, ...assignments];
}

function hasForkApiKeyOverride(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--api-key" || arg.startsWith("--api-key=")) return true;
		if (flagConsumesValue(arg, argv[i + 1])) i++;
	}
	return false;
}

export class CommandController {
	/** The open native report sheet and the component it shows. */
	#reportSheet: { handle: OverlayHandle; component: Component } | undefined;
	#forkTerminalDependencies: ForkTerminalDependencies;
	/** The watcher serving the queued `/compact`, while one runs. */
	#yieldCompactionWatcher: Promise<void> | undefined;

	constructor(
		private readonly ctx: InteractiveModeContext,
		forkTerminalDependencies: Partial<ForkTerminalDependencies> = {},
	) {
		this.#forkTerminalDependencies = {
			classifyTerminalMultiplexer,
			environment: () => process.env,
			launchTerminal,
			resolveCliEntryCmd,
			getActiveProfile,
			argv: () => process.argv.slice(2),
			...forkTerminalDependencies,
		};
	}

	/** Esc: take away the report shown above the editor (text mode); false when none is shown. */
	dismissCommandReport(): boolean {
		return this.#clearReport();
	}

	/**
	 * Drop any report — the one above the editor, or a focused sheet/page —
	 * because the transcript or session under it was reset, and its contents
	 * describe what is gone.
	 */
	clearCommandReport(): void {
		this.#clearReport();
		this.#closeReportSheet();
	}

	#clearReport(): boolean {
		const docked = this.ctx.reportContainer;
		if (docked.children.length === 0) return false;
		docked.dispose();
		docked.clear();
		this.ctx.ui.requestRender();
		return true;
	}

	#closeReportSheet(): void {
		const sheet = this.#reportSheet;
		if (!sheet) return;
		this.#reportSheet = undefined;
		sheet.handle.hide();
		// Like the docked report, a closed sheet is never shown again.
		sheet.component.dispose?.();
		this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/** Open `component` as a focused full-screen page; callers close any previous sheet first. */
	#showFullscreenSheet(component: Component): void {
		const handle = this.ctx.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#reportSheet = { handle, component };
		this.ctx.ui.setFocus(component);
	}

	/**
	 * Show a read-only report, replacing the previous one. In text mode one that
	 * fits the rows above the editor shows there like `/btw`: the editor keeps
	 * focus and its Esc takes the report away. A taller one opens as a
	 * full-screen page on the terminal's alternate screen, scrolled with the
	 * arrow/page keys and the wheel, so the main screen is never touched and
	 * Esc returns to it as it was. Natively it is a focused sheet like
	 * `/usage`, its body scrolled by the terminal once it is long, closed by
	 * Esc or Close.
	 */
	showCommandReport(options: { title: string; head?: TspText; body: Component }): void {
		this.#clearReport();
		this.#closeReportSheet();
		const terminal = this.ctx.ui.terminal;
		const inline = this.ctx.commandReportRows() ?? terminal.rows;
		let fullScreen = false;
		const report = new ReportPanel({
			...options,
			closeKey: appKey(this.ctx.keybindings, "app.interrupt"),
			onClose: () => this.#closeReportSheet(),
			maxRows: () => (fullScreen ? terminal.rows : this.ctx.commandReportRows()),
		});
		if (isNativeRendering()) {
			report.holdFocus();
			this.#reportSheet = {
				handle: this.ctx.ui.showOverlay(report, { anchor: "center", width: "90%", maxHeight: "90%" }),
				component: report,
			};
			this.ctx.ui.setFocus(report);
		} else if (report.heightAt(terminal.columns) > inline) {
			fullScreen = true;
			report.holdFocus();
			this.#showFullscreenSheet(report);
		} else {
			this.ctx.reportContainer.addChild(report);
		}
		this.ctx.ui.requestRender();
	}

	/** A titled markdown report; see {@link showCommandReport}. */
	#showMarkdownPanel(title: string, markdown: string): void {
		this.showCommandReport({ title, body: new Markdown(markdown.trim(), 0, 0, getMarkdownTheme()) });
	}

	async #restoreAfterMoveFailure(
		previousState: Parameters<InteractiveModeContext["sessionManager"]["rollbackMove"]>[0],
		initialError?: unknown,
	): Promise<void> {
		if (initialError !== undefined) {
			this.ctx.showError(
				`Failed to switch workspace: ${initialError instanceof Error ? initialError.message : String(initialError)}`,
			);
		}

		try {
			await this.ctx.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			const actual = this.ctx.sessionManager.getCwd();
			let realigned = false;
			try {
				realigned = await this.ctx.applyCwdChange(actual);
			} catch {}
			if (!realigned) {
				this.ctx.showError(
					`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (failed to re-align workspace to ${actual})`,
				);
				await this.ctx.shutdown();
				return;
			}
			this.ctx.showError(
				`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (workspace remains at ${actual})`,
			);
			return;
		}

		let sourceRestored = false;
		try {
			sourceRestored = await this.ctx.applyCwdChange(previousState.cwd);
		} catch {}
		if (sourceRestored) return;

		const actual = this.ctx.sessionManager.getCwd();
		let realigned = false;
		try {
			realigned = await this.ctx.applyCwdChange(actual);
		} catch {}
		if (!realigned) {
			this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
			await this.ctx.shutdown();
			return;
		}
		this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
	}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}
	async handleTraceCommand(): Promise<void> {
		const sessionFile = this.ctx.session.sessionFile;
		if (!sessionFile) {
			this.ctx.showWarning("No session file yet — send a message first.");
			return;
		}
		try {
			// Lazy: the stats dashboard (server + sqlite) loads on demand only,
			// matching src/cli/stats-cli.ts, to keep CLI startup fast.
			const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
			const { hostname, port } = await startServer();
			const url = `${formatStatsDashboardUrl(hostname, port)}/#/traces?s=${encodeURIComponent(sessionFile)}`;
			this.openInBrowser(url);
			this.ctx.showStatus(`Trace: ${url}`);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to open trace: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	handleDumpAllCommand(): Promise<void> {
		return this.#writeDumpArchive(() => this.ctx.session.dumpSessionArchiveToTmpDir());
	}

	handleDumpAnonCommand(): Promise<void> {
		return this.#writeDumpArchive(() => this.ctx.session.dumpAnonymizedArchiveToTmpDir());
	}

	async #writeDumpArchive(write: () => Promise<SessionDumpArchive | undefined>): Promise<void> {
		try {
			const archive = await write();
			if (!archive) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			await copyToClipboard(archive.path);
			this.ctx.showStatus([...formatDumpArchiveReport(archive), "Archive path copied to clipboard"].join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write session dump: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError("Advisor is not active for this session.");
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError("Advisor has no history yet.");
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus("Advisor history copied to clipboard");
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to copy advisor history: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(Bun.stripANSI(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const premiumRequests =
			"premiumRequests" in stats && typeof stats.premiumRequests === "number"
				? stats.premiumRequests
				: this.ctx.session.sessionManager.getUsageStatistics().premiumRequests;
		const normalizedPremiumRequests = Math.round((premiumRequests + Number.EPSILON) * 100) / 100;

		let info = "";
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n`;
		const builds = runtimeIdentityHistory(this.ctx.session.sessionManager.getEntries());
		const running = currentRuntimeIdentity();
		// A source checkout's diff hash changes with each edit, so a long-lived session can collect
		// many builds: keep the first and the latest few. Every row is keyed so the overlay never
		// mistakes a colourless continuation row for a section heading.
		const hidden = builds.length > MAX_LISTED_BUILDS ? builds.length - MAX_LISTED_BUILDS + 1 : 0;
		for (const [index, build] of builds.entries()) {
			if (hidden > 0 && index > 0 && index <= hidden) {
				if (index === 1) info += `${theme.fg("dim", `Builds 2–${hidden + 1}:`)} ${hidden} more\n`;
				continue;
			}
			const key = builds.length === 1 ? "Build:" : `Build ${index + 1}:`;
			info += `${theme.fg("dim", key)} ${replaceTabs(sanitizeText(formatRuntimeIdentity(build)))}\n`;
		}
		if (!sameRuntimeIdentity(builds[builds.length - 1], running)) {
			info += `${theme.fg("dim", "Running:")} ${replaceTabs(sanitizeText(formatRuntimeIdentity(running)))}\n`;
		}
		info += `\n${theme.bold("Provider")}\n`;
		const model = this.ctx.session.model;
		if (!model) {
			info += `${theme.fg("dim", "No model selected")}\n`;
		} else {
			info += `${theme.fg("dim", "Model:")} ${model.provider}/${model.id}\n`;
			info += `${theme.fg("dim", "Endpoint:")} ${model.baseUrl}\n`;
			const source = this.ctx.session.modelRegistry.authStorage.keys.describe(model.provider, stats.sessionId);
			if (source) info += `${theme.fg("dim", "Credential:")} ${source}\n`;
			if (stats.routedModels !== undefined) {
				const routed = Object.entries(stats.routedModels)
					.sort(([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId))
					.map(
						([id, count]) => `${replaceTabs(sanitizeText(id))}${count > 1 ? theme.fg("dim", ` ×${count}`) : ""}`,
					);
				info += `${theme.fg("dim", "Served:")} ${routed.join(", ")}\n`;
			}
		}
		info += `\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		if (stats.editRejections !== undefined) {
			const kinds = Object.entries(stats.editRejections).sort(
				([aKind, aCount], [bKind, bCount]) => bCount - aCount || aKind.localeCompare(bKind),
			);
			const total = kinds.reduce((sum, [, count]) => sum + count, 0);
			const breakdown = kinds
				.map(([kind, count]) => `${replaceTabs(sanitizeText(kind.replaceAll("_", " ")))} ${count}`)
				.join(", ");
			info += `${theme.fg("dim", "Edit Rejections:")} ${total} ${theme.fg("dim", `(${breakdown})`)}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		// Append-only context
		{
			const setting = cfgProviderAppendOnlyContext.get(this.ctx.settings);
			const mode = shouldEnableAppendOnlyContext(setting);
			const activeLabel = mode ? theme.fg("success", "active") : theme.fg("dim", "inactive");
			const settingLabel = setting;
			info += `${theme.fg("dim", "Append-Only:")} ${activeLabel} (setting: ${settingLabel})\n`;
		}
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || normalizedPremiumRequests > 0 || stats.credits !== undefined) {
			info += `\n${theme.bold("Cost")}\n`;
			if (stats.cost > 0) {
				info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}\n`;
			}
			if (normalizedPremiumRequests > 0) {
				info += `${theme.fg("dim", "Premium Requests:")} ${normalizedPremiumRequests.toLocaleString()}\n`;
			}
			if (stats.credits !== undefined) {
				info += `${theme.fg("dim", "Credits:")} ${formatCreditValue(stats.credits.cost)}\n`;
				info += `${theme.fg("dim", "Committed Credits:")} ${formatCreditValue(stats.credits.committedCost)}\n`;
				info += `${theme.fg("dim", "Committed ACU:")} ${formatCreditValue(stats.credits.acuCost)}\n`;
			}
		}

		if (this.ctx.lspServers && this.ctx.lspServers.length > 0) {
			info += `\n${theme.bold("LSP Servers")}\n`;
			for (const server of this.ctx.lspServers) {
				const statusColor =
					server.status === "ready"
						? "success"
						: server.status === "available"
							? "dim"
							: server.status === "connecting"
								? "warning"
								: "error";
				const statusText =
					server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status;
				info += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(statusColor, statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
			}
		}

		if (this.ctx.mcpManager) {
			const mcpServers = this.ctx.mcpManager.getConnectedServers();
			info += `\n${theme.bold("MCP Servers")}\n`;
			if (mcpServers.length === 0) {
				info += `${theme.fg("dim", "None connected")}\n`;
			} else {
				for (const name of mcpServers) {
					const conn = this.ctx.mcpManager.getConnection(name);
					const toolCount = conn?.tools?.length ?? 0;
					info += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", "connected")} ${theme.fg("dim", `(${toolCount} tools)`)}\n`;
				}
			}
		}

		this.ctx.showSessionInfo(info, this.ctx.session.getContextUsage());
	}

	static readonly #advisorStatusGlyph: Record<string, string> = {
		running: "●",
		paused: "○",
		no_model: "○",
		quota_exhausted: "✕",
		error: "✕",
	};

	static readonly #advisorStatusLabel: Record<string, string> = {
		running: "running",
		paused: "off",
		no_model: "no model",
		quota_exhausted: "quota exhausted",
		error: "error",
	};

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.showCommandReport({ title: "Advisor Status", body: new Text("Advisor is disabled.", 0, 0) });
			return;
		}
		// Roster view: show every configured advisor with its status, even when
		// none are live (all paused/no-model). The old code returned a generic
		// message that hid the per-advisor state the user needs to act on.
		if (stats.advisors.length > 1 || (stats.configured && !stats.active)) {
			let info = "";
			for (const a of stats.advisors) {
				const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
				const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
				const color =
					a.status === "running"
						? "success"
						: a.status === "quota_exhausted" || a.status === "error"
							? "error"
							: "dim";
				info += `\n${theme.fg(color, glyph)} ${theme.bold(a.name)} ${theme.fg("dim", `[${label}]`)}\n`;
				if (a.model) {
					info += `${theme.fg("dim", "Model:")} ${a.model.provider}/${a.model.id}\n`;
				}

				if (a.status === "running" || a.status === "quota_exhausted") {
					const ctx =
						a.contextWindow > 0
							? `${a.contextTokens.toLocaleString()} / ${a.contextWindow.toLocaleString()} (${Math.round((a.contextTokens / a.contextWindow) * 100)}%)`
							: `${a.contextTokens.toLocaleString()}`;
					info += `${theme.fg("dim", "Context:")} ${ctx}\n`;
					info += `${theme.fg("dim", "Messages:")} ${a.messages.total.toLocaleString()}\n`;
					info += `${theme.fg("dim", "Spend:")} ${a.tokens.input.toLocaleString()} in / ${a.tokens.output.toLocaleString()} out`;
					if (a.cost > 0) info += `, $${a.cost.toFixed(4)}`;
					info += "\n";
				}
			}
			if (stats.active) {
				info += `\n${theme.bold("Totals")}\n`;
				info += `${theme.fg("dim", "Tokens:")} ${stats.tokens.total.toLocaleString()}\n`;
				if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
			}
			this.showCommandReport({
				title: `Advisor Status (${stats.advisors.length} advisors)`,
				body: new Text(info.trim(), 0, 0),
			});
			return;
		}
		// Single active advisor — detailed view.
		const model = stats.model;
		let info = "";
		if (stats.advisors.length === 1) {
			const a = stats.advisors[0];
			const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
			const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
			info += `${theme.fg(a.status === "running" ? "success" : "error", glyph)} ${a.name} ${theme.fg("dim", `[${label}]`)}\n\n`;
		}
		if (model) {
			info += `${theme.bold("Provider")}\n`;
			info += `${theme.fg("dim", "Model:")} ${model.provider}/${model.id}\n`;
		}

		info += `\n${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.messages.user.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.messages.assistant.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.messages.total.toLocaleString()}\n`;
		info += `\n${theme.bold("Context")}\n`;
		if (stats.contextWindow > 0) {
			const percent = Math.round((stats.contextTokens / stats.contextWindow) * 100);
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${percent}%)\n`;
		} else {
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()}\n`;
		}
		info += `\n${theme.bold("Spend")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
		this.showCommandReport({ title: "Advisor Status", body: new Text(info.trim(), 0, 0) });
	}

	/**
	 * `/jobs`: natively the live jobs sheet the jobs pill opens (inspect and
	 * cancel included); `/jobs full`, and text mode, a report of the running
	 * and recent jobs (see {@link showCommandReport}). Both list the viewed
	 * session's jobs and its subagents' as a tree (see {@link buildJobTree}).
	 */
	async handleJobsCommand(options?: { full?: boolean }): Promise<void> {
		const full = options?.full === true;
		if (full) this.ctx.viewSession.requestJobCaptions();
		const tree = this.ctx.viewSession.getAsyncJobTree();
		if (!tree) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}
		if (isNativeRendering() && !full) {
			this.ctx.showJobsSheet();
			return;
		}

		const now = Date.now();
		const columns = this.ctx.ui.terminal.columns ?? 100;
		let info = `${theme.fg("dim", "Running:")} ${tree.running.length}\n`;
		if (tree.running.length === 0 && tree.recent.length === 0) {
			info += `\n${theme.fg("dim", "No async jobs yet.")}`;
			this.showCommandReport({ title: "Background Jobs", body: new Text(info, 0, 0) });
			return;
		}

		// Lines under a row hang off its tree rails. Full mode wraps here so
		// every line, including heredoc lines and wrap continuations, keeps that
		// indent inside the report box.
		info += "\n";
		for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
			const guide = theme.fg("dim", jobTreeGuide(row, theme));
			if (row.kind === "agent") {
				info += `${guide}${theme.bold(row.agent.id)}\n`;
				continue;
			}
			const { job } = row;
			// A spawned subagent's task job takes the agent's id as its id and label: name it once.
			const agent = row.agent && row.agent.id !== job.id ? ` ${theme.bold(row.agent.id)}` : "";
			info += `${guide}${renderJobLine(job, now)}${agent}\n`;
			// What the job is for leads; full mode follows it with what the command does and the whole command.
			const text = full ? (job.command ?? job.label) : (job.intent ?? job.label);
			if (text === job.id) continue;
			const indent = jobTreeIndent(row, theme);
			const prefix = theme.fg("dim", indent);
			if (!full) {
				const label = truncateJobLabel(text, Math.max(24, columns - 22 - visibleWidth(indent)));
				info += `${prefix}${theme.fg("dim", label)}\n`;
				continue;
			}
			for (const line of wrapTextWithAnsi(
				shortenEmbeddedPaths(replaceTabs(sanitizeText([job.intent, job.caption, text].filter(Boolean).join("\n")))),
				Math.max(1, columns - 4 - visibleWidth(indent)),
			)) {
				info += `${prefix}${theme.fg("dim", line)}\n`;
			}
		}

		this.showCommandReport({ title: "Background Jobs", body: new Text(info.trimEnd(), 0, 0) });
	}

	async handleChangelogCommand(args = ""): Promise<void> {
		const view = parseChangelogView(args);
		if ("error" in view) {
			this.ctx.showWarning(view.error);
			return;
		}
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = selectChangelogEntries(allEntries, view);
		const changelogMarkdown =
			entriesToShow.length > 0 ? renderChangelogEntries(entriesToShow).markdown : "No changelog entries found.";
		const shown = entriesToShow.length;
		const titleCount = shown > 0 ? shown : view.kind === "last" ? view.count : shown;
		const title =
			view.kind === "full"
				? "Full Changelog"
				: view.kind === "last"
					? titleCount === 1
						? "Last Release"
						: `Last ${titleCount} Releases`
					: "Recent Changes";
		const hint =
			view.kind === "full"
				? ""
				: `\n\n${theme.fg("dim", "Use")} ${theme.bold("/changelog full")} ${theme.fg("dim", "to view the complete changelog.")}`;

		this.#showMarkdownPanel(title, changelogMarkdown + hint);
	}

	handleHotkeysCommand(): void {
		const bindings = { keybindings: this.ctx.keybindings };
		if (isNativeRendering()) {
			// A native terminal gets a dismissable sheet with keycaps instead of a markdown table.
			const sheet = new HotkeysSheetComponent(bindings, () => {
				handle.hide();
				this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
				this.ctx.ui.requestRender();
			});
			const handle = this.ctx.ui.showOverlay(sheet, { anchor: "center", width: "90%", maxHeight: "90%" });
			this.ctx.ui.setFocus(sheet);
			this.ctx.ui.requestRender();
			return;
		}
		this.#showMarkdownPanel("Keyboard Shortcuts", buildHotkeysMarkdown(bindings));
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		this.#showMarkdownPanel("Available Tools", tools);
	}

	handleContextCommand(): void {
		const session = this.ctx.session;
		if (!session.model) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		// Validate capacity before tokenizing the whole history into a snapshot.
		const breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
		if (!(breakdown.contextWindow > 0) || !Number.isFinite(breakdown.contextWindow)) {
			this.ctx.showWarning("Context usage is unavailable: the model's context window is unknown or invalid.");
			return;
		}
		const data = buildSessionContextView(session, breakdown);
		this.#clearReport();
		this.#closeReportSheet();
		const viewer = new ContextViewer(data, {
			onClose: () => this.#closeReportSheet(),
			requestRender: () => this.ctx.ui.requestRender(),
			getRows: () => this.ctx.ui.terminal.rows,
		});
		this.#showFullscreenSheet(viewer);
		this.ctx.ui.requestRender();
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		// A focused subagent view keeps its own history: return to the main session
		// first so the transcript below cannot rebuild from the subagent's surviving
		// conversation, then drop any turn-scoped anchors (coalescing timers,
		// in-flight dispatches) the session boundary orphaned.
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${label}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before starting a fresh session.");
			return;
		}
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus("Fresh session started.");
	}

	async handleResetContextCommand(): Promise<void> {
		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		const result = await this.ctx.session.resetSessionContext();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before resetting the context.");
			return;
		}
		// Drop the rendered transcript so the UI matches the now-empty model
		// context (mirrors #runNewSessionFlow's teardown, minus the new session —
		// the session id, title, and transcript file all survive).
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		const noun = result.droppedCount === 1 ? "message" : "messages";
		this.ctx.present([
			new Spacer(1),
			new Text(
				`${theme.fg("accent", `${theme.status.success} Context reset — ${result.droppedCount} ${noun} dropped; session continues.`)}`,
				1,
				1,
			),
		]);
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleDeleteCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to delete (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session deleted");
	}

	async handleForkCommand(placement?: "pane" | "window"): Promise<void> {
		if (placement !== undefined) {
			await this.#handleForkTerminalCommand(placement);
			return;
		}

		// A Tern pane fork leaves this session untouched, so it may run mid-turn.
		if (await this.#forkIntoTernPane()) return;

		// An in-place fork moves this process onto the new file; a running turn
		// would finish there and leave the original transcript cut mid-turn.
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		// After a `/fork`, the current session ID is changed to the forked one,
		// so the session ID before the fork is the one we want to show in the hint.
		const previousSessionId = this.ctx.sessionManager.isSessionOnDisk()
			? this.ctx.sessionManager.getSessionId()
			: undefined;

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(
				theme.fg(
					"accent",
					previousSessionId
						? `${theme.status.success} Session forked · return to original: ${resumeCommand(previousSessionId)} or /resume ${previousSessionId}`
						: `${theme.status.success} Session forked`,
				),
				1,
				1,
			),
		]);
	}

	async #handleForkTerminalCommand(placement: "pane" | "window"): Promise<void> {
		const dependencies = this.#forkTerminalDependencies;
		const environment = dependencies.environment();
		const multiplexer = dependencies.classifyTerminalMultiplexer(environment);
		const placementInfo = getTerminalLaunchPlacement(multiplexer, placement);
		if ("error" in placementInfo) {
			this.ctx.showError(placementInfo.error);
			return;
		}

		if (this.ctx.session.isStreaming) {
			const confirmed = await this.ctx.showHookConfirm(
				"Fork while a response is running?",
				"The child may not include the partial response. Continue opening a fork? The current session will keep running here.",
			);
			if (!confirmed) return;
		}

		const initialSessionFile = this.ctx.sessionManager.getSessionFile();
		if (!initialSessionFile) {
			this.ctx.showError("Cannot open a fork in another terminal: the current session has not been persisted yet.");
			return;
		}

		const childArgs = restartArgv(dependencies.argv(), undefined, FORK_LAUNCH_OVERRIDES);
		if (hasForkApiKeyOverride(childArgs)) {
			this.ctx.showError(
				"Cannot open a fork in another terminal when --api-key was supplied at startup; the key cannot be forwarded without exposing it in the multiplexer command. Configure provider credentials in the auth store and retry.",
			);
			return;
		}
		const shellGrammar = placementInfo.shellGrammar;
		if (shellGrammar === "posix") {
			const confirmed = await this.ctx.showHookConfirm(
				"Confirm destination shell compatibility",
				"This fork command uses POSIX shell syntax. Continue only if the destination's configured interactive shell accepts POSIX syntax; this cannot be inferred from the current terminal.",
			);
			if (!confirmed) {
				this.ctx.showWarning("Fork cancelled: POSIX shell compatibility was not confirmed for the destination.");
				return;
			}
		}

		try {
			await this.ctx.sessionManager.flush();
		} catch (error) {
			logger.error("Failed to flush the session before opening a terminal fork", { error });
			this.ctx.showError("Cannot open a fork in another terminal: failed to save the current session.");
			return;
		}

		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("Cannot open a fork in another terminal: the current session is no longer persisted.");
			return;
		}
		const sourceSessionFile = path.resolve(sessionFile);
		try {
			await fs.access(sourceSessionFile);
		} catch {
			this.ctx.showError("Cannot open a fork in another terminal: the persisted session transcript is unavailable.");
			return;
		}

		try {
			const activeProfile = dependencies.getActiveProfile();
			const activeModel = this.ctx.session.model;
			if (activeProfile) childArgs.push("--profile", activeProfile);
			if (activeModel) childArgs.push("--model", `${activeModel.provider}/${activeModel.id}`);
			const activeThinkingLevel = this.ctx.session.configuredThinkingLevel();
			if (activeThinkingLevel !== undefined) childArgs.push("--thinking", activeThinkingLevel);
			// Forcing --model/--thinking marks the fork's cache shape as changed, which would
			// drop the inherited key. Automatic candidates travel in the source header;
			// forwarding them as --prompt-cache-key would bypass their model gate.
			if (
				this.ctx.session.agent.promptCacheKey !== undefined ||
				this.ctx.sessionManager.getHeader()?.taskPromptCacheKey === undefined
			) {
				childArgs.push("--prompt-cache-key", this.ctx.session.agent.promptCacheKey ?? this.ctx.session.sessionId);
			}
			childArgs.push("--fork", sourceSessionFile);
			// Pin only non-secret scope variables.
			const command = [
				...forkScopeEnvCommand({
					PI_CODING_AGENT_DIR: this.ctx.settings.getAgentDir(),
					PI_CONFIG_DIR: getConfigDirName(),
					OMP_PROFILE: activeProfile,
					PI_PROFILE: activeProfile,
					PI_CONFIG_FILES: this.ctx.settings.getConfigFiles().join(path.delimiter),
					PI_CODING_AGENT_SESSION_DIR: environment.PI_CODING_AGENT_SESSION_DIR,
					XDG_DATA_HOME: environment.XDG_DATA_HOME,
					XDG_STATE_HOME: environment.XDG_STATE_HOME,
					XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
				}),
				...dependencies.resolveCliEntryCmd(),
				...childArgs,
			];
			const launchPlan = createDefaultTerminalLaunchRequest(
				multiplexer,
				placement,
				command,
				this.ctx.sessionManager.getCwd(),
				shellGrammar,
			);
			if ("error" in launchPlan) {
				this.ctx.showError(launchPlan.error);
				return;
			}

			const result = await dependencies.launchTerminal(launchPlan.request);
			if (result.warning) {
				this.ctx.showWarning(
					`Opened a fork in ${placementInfo.displayName}, but ${result.warning} This session continues here.`,
				);
				return;
			}
			this.ctx.showStatus(
				`Opened a fork in ${placementInfo.displayName} (${placementInfo.placementLabel}); this session continues here.`,
			);
		} catch (error) {
			logger.error("Failed to open a terminal fork", { multiplexer, error });
			this.ctx.showError(
				error instanceof TerminalLaunchError
					? `Could not open a fork in ${placementInfo.displayName}: ${error.message}`
					: `Could not open a fork in ${placementInfo.displayName}. See logs for details.`,
			);
		}
	}

	/**
	 * `/fork` inside a Tern pane: ask Tern to run `omp --fork` of this session in a new pane beside
	 * this one, which keeps the original session. False means fork in place instead: outside Tern,
	 * an unsaved session, a Tern without `fork`, or Tern refusing it. Once the request is out, an
	 * unconfirmed one is reported rather than retried in place, since Tern may still open the pane.
	 */
	async #forkIntoTernPane(): Promise<boolean> {
		const tern = resolveTernPane();
		if (!tern || !this.ctx.sessionManager.isSessionOnDisk()) return false;
		const client = new TernSocketClient({ socketPath: tern.socketPath });
		try {
			try {
				await client.connect();
			} catch (error) {
				logger.debug("Tern unreachable for /fork; forking in place", {
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (!client.supports("fork")) return false;
			// The new pane's omp reads the session file as it starts.
			await this.ctx.session.flushToDisk();
			try {
				await client.fork({ block: tern.pane }, { timeoutMs: TERN_FORK_TIMEOUT_MS });
			} catch (error) {
				if (error instanceof TernError && !TERN_FORK_UNCONFIRMED[error.kind]) {
					const details = { kind: error.kind, error: error.message };
					if (error.kind === "failed") logger.warn("Tern could not open the fork pane; forking in place", details);
					else logger.debug("Tern refused the fork; forking in place", details);
					return false;
				}
				this.ctx.showError(
					`Tern did not confirm the fork: ${error instanceof Error ? error.message : String(error)}`,
				);
				return true;
			}
		} finally {
			client.close();
		}
		const note = this.ctx.session.isStreaming ? " · the running response continues here, not in the fork" : "";
		this.ctx.present([
			new Spacer(1),
			new Text(theme.fg("accent", `${theme.status.success} Session forked into a new pane${note}`), 1, 1),
		]);
		return true;
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) =>
					new MoveOverlay(this.ctx.sessionManager.getCwd(), done, moveDirectorySource),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(`Cannot create "${path.basename(resolvedPath)}": parent directory does not exist`);
				return;
			}
		}
		const moved = await this.#withSessionMove(async () => {
			if (!isDirectory) {
				const confirmed = await this.ctx.showHookConfirm(
					"Create directory?",
					`"${path.basename(resolvedPath)}" does not exist. Create it?`,
				);
				if (!confirmed) return false;
				try {
					await fs.mkdir(resolvedPath, { recursive: true });
				} catch (err) {
					this.ctx.showError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
					return false;
				}
			}
			return this.#relocateSession(resolvedPath);
		});
		if (moved) {
			this.ctx.present([
				new Spacer(1),
				new Text(`${theme.fg("accent", `${theme.status.success} Moved to ${resolvedPath}`)}`, 1, 1),
			]);
		}
	}

	/**
	 * `/wt [<branch>]` — fork the checkout into a new linked git worktree on
	 * `branch` (default `wt/<timestamp>`), carrying uncommitted changes along
	 * unless `keepChanges` is false, then relocate the session there like `/move`.
	 * Returns the worktree only when the session now lives in it.
	 */
	async handleWorktreeCommand(
		branch?: string,
		options: { keepChanges?: boolean } = {},
	): Promise<SessionWorktree | undefined> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before creating a worktree.");
			return undefined;
		}
		let created: SessionWorktree | undefined;
		await this.#withSessionMove(async () => {
			const branchName = branch?.trim() || defaultSessionWorktreeBranch();
			const cwd = this.ctx.sessionManager.getCwd();
			this.ctx.statusContainer.disposeChildren();
			const loader = new Loader(
				this.ctx.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				`Creating worktree on ${branchName}…`,
				getSymbolTheme().spinnerFrames,
			);
			this.ctx.statusContainer.addChild(loader);
			this.ctx.ui.requestRender();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(cwd, this.ctx.settings, branchName, options);
			} catch (err) {
				this.ctx.showError(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			} finally {
				loader.stop();
				this.ctx.statusContainer.disposeChildren();
			}
			if (worktree.cloneError) {
				logger.warn("worktree clone fell back to plain checkout", {
					path: worktree.path,
					error: worktree.cloneError,
				});
			}
			if (!(await this.#relocateSession(worktree.path))) return false;
			created = worktree;
			const cleanup = worktree.keptChanges
				? await cleanSourceCheckoutIfConfigured(cwd, this.ctx.settings)
				: { cleaned: false, errorMessage: undefined };
			if (cleanup.errorMessage !== undefined) {
				this.ctx.showWarning(`Worktree created, but cleaning source checkout failed: ${cleanup.errorMessage}`);
			}
			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", `${theme.status.success} ${formatSessionWorktreeSummary(worktree, cleanup.cleaned)}`)}`,
					1,
					1,
				),
			]);
			return true;
		});
		return created;
	}

	/** Save source settings before acquiring the gate for a complete relocation operation. */
	async #withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}

		return this.ctx.withBtwSessionMove(operation);
	}

	/** Relocate only while #withSessionMove holds the BTW gate; false means no successful move. */
	async #relocateSession(resolvedPath: string): Promise<boolean> {
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		const previousState = this.ctx.sessionManager.captureState();
		try {
			await this.ctx.session.moveSession(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		let applied = false;
		try {
			applied = await this.ctx.applyCwdChange(resolvedPath);
		} catch (error) {
			await this.#restoreAfterMoveFailure(previousState, error);
			return false;
		}
		if (!applied) {
			await this.#restoreAfterMoveFailure(previousState);
			return false;
		}

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleRenameCommand(title: string): Promise<void> {
		const session = this.ctx.session;
		const sessionManager = this.ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const signal = session.titleGenerationSignal;
		let titleRevision = sessionManager.titleRevision;
		const isCurrent = () =>
			this.ctx.session === session &&
			this.ctx.sessionManager === sessionManager &&
			!signal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === titleRevision;
		try {
			const persistence = sessionManager.setSessionName(title, "user");
			titleRevision = sessionManager.titleRevision;
			const stored = await persistence;
			if (!isCurrent()) return;
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			if (!isCurrent()) return;
			this.ctx.showError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before changing directories.");
			return;
		}

		if (shouldPersistCwd) {
			await this.#withSessionMove(() => this.#executeBashCommand(command, excludeFromContext, isDeferred, true));
		} else {
			await this.#executeBashCommand(command, excludeFromContext, isDeferred, false);
		}
	}

	/** Returns whether shell execution committed a cwd relocation, not whether the shell command succeeded. */
	async #executeBashCommand(
		command: string,
		excludeFromContext: boolean,
		isDeferred: boolean,
		shouldPersistCwd: boolean,
	): Promise<boolean> {
		const component = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);
		this.ctx.bashComponent = component;
		// Provisional until the session records the run.
		const block = new PresentedBlock(
			component,
			messageBlock({
				role: "bashExecution",
				command,
				output: "",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext,
			}),
		);
		block.setExpanded(this.ctx.toolOutputExpanded);
		let detachInput: (() => void) | undefined;
		let finished = false;

		if (isDeferred) {
			this.ctx.pendingShellContainer.addChild(block);
			this.ctx.pendingBashComponents.push(block);
		} else {
			this.ctx.present(block);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeBash(
				command,
				chunk => {
					if (this.ctx.bashComponent) {
						this.ctx.bashComponent.appendOutput(chunk);
					}
				},
				{
					excludeFromContext,
					onRecorded: message => block.setBlock(messageBlock(message)),
					useUserShell: true,
					// User-shell zsh/fish `!` commands run on a headless PTY; raw
					// bytes render through the component's vterm replay (color-safe).
					pty: {
						...bashPtyViewport(this.ctx.ui),
						onChunk: chunk => this.ctx.bashComponent?.appendPtyChunk(chunk),
						onStdin: write => {
							if (finished) return;
							// A TSP field without a mode handles printable keys itself and sends
							// `edit` packets instead of raw input. Label it while the PTY owns
							// the keyboard so Tern delivers those keys to the input listener.
							detachInput = this.#forwardKeysToPty(component, write);
							this.ctx.editor.nativeKeyPassthrough = true;
							this.ctx.ui.requestRender();
						},
					},
				},
			);
			if (this.ctx.bashComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.bashComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
					minimized: result.minimized,
					images: result.images,
					showImages: cfgTerminalShowImages.get(this.ctx.settings),
				});
			}
			try {
				if (shouldPersistCwd) return await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					`Bash command completed, but OMP failed to update its working directory: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			if (this.ctx.bashComponent) {
				this.ctx.bashComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		} finally {
			finished = true;
			detachInput?.();
			if (detachInput) this.ctx.editor.nativeKeyPassthrough = false;
			this.ctx.bashComponent = undefined;
			this.ctx.ui.requestRender();
		}
		return false;
	}

	/**
	 * Routes composer keystrokes to a running `!` command's PTY so it can answer
	 * its own prompts (`read`, shell-startup questions), like a foreground job.
	 * The interrupt key still cancels; focused dialogs and mouse reports keep
	 * their input. Returns the detach function.
	 */
	#forwardKeysToPty(component: BashExecutionComponent, write: (data: string) => void): () => void {
		return this.ctx.ui.addInputListener(
			data => {
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.keybindings.matches(data, "app.interrupt") || parseSgrMouse(data)) return undefined;
				const bytes = component.encodePtyInput(data);
				if (bytes) write(bytes);
				return { consume: true };
			},
			{ prepend: true },
		);
	}

	async #applyBashResultCwd(result: BashResult): Promise<boolean> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return false;
		if (!path.isAbsolute(result.workingDir)) return false;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return false;

		return this.#relocateSession(resolvedPath);
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext);
		// Provisional until the session records the cell.
		const block = new PresentedBlock(
			this.ctx.pythonComponent,
			messageBlock({
				role: "pythonExecution",
				code,
				output: "",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext,
			}),
		);
		block.setExpanded(this.ctx.toolOutputExpanded);

		if (isDeferred) {
			this.ctx.pendingShellContainer.addChild(block);
			this.ctx.pendingPythonComponents.push(block);
		} else {
			this.ctx.present(block);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executePython(
				code,
				chunk => {
					if (this.ctx.pythonComponent) {
						this.ctx.pythonComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext, onRecorded: message => block.setBlock(messageBlock(message)) },
			);

			if (this.ctx.pythonComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.pythonComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
				});
			}
		} catch (error) {
			if (this.ctx.pythonComponent) {
				this.ctx.pythonComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Python execution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead. That caller also dispatches
		// the execution turn itself, so the compaction must not resume the
		// plan-approval turn it aborted.
		if (options?.internalGuidance) {
			return this.executeCompaction(
				{ internalGuidance: options.internalGuidance, suppressContinuation: true, ...(mode ? { mode } : {}) },
				false,
				beforeFlush,
				mode,
				options.readerModel,
			);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode, options?.readerModel);
	}

	/**
	 * Run the `/compact` queued for the next yield once the session goes quiet. One watcher serves the
	 * request from the moment it is queued, so no single event (an `agent_end` that a stale-settle guard
	 * skips, a setup that bails without one) can strand it; later calls join the running watcher.
	 * Follow-ups queued behind the request wait in `compactionQueuedMessages` and flush once it ends.
	 */
	runYieldCompaction(): Promise<void> {
		this.#yieldCompactionWatcher ??= this.#watchYieldCompaction().finally(() => {
			this.#yieldCompactionWatcher = undefined;
		});
		return this.#yieldCompactionWatcher;
	}

	async #watchYieldCompaction(): Promise<void> {
		let request = this.ctx.yieldCompaction;
		if (!request) return;
		const session = this.ctx.session;
		while (true) {
			await session.waitForIdle();
			// Input sent before the request reaches the session first, also while it is still dispatching.
			await this.ctx.waitForSubmissionDispatches();
			await session.waitForAdmittedSubmissions();
			// Let a session switch commit or roll back before judging which conversation is live.
			if (session.isSessionTransitioning) await session.waitForSessionTransition();
			if (session.hasPendingAsyncWork()) await session.settleAsyncWork();
			if (this.ctx.session !== session) return;
			if (this.ctx.yieldCompaction !== request) {
				// Dequeued (and maybe queued again): serve whatever request is pending now.
				if (!this.ctx.yieldCompaction) return;
				request = this.ctx.yieldCompaction;
				continue;
			}
			// The run yielded only once nothing can continue it: no turn, retry, queued input, pending
			// submission, background job, or transition. Otherwise something is mid-flight; look again.
			if (
				!session.isStreaming &&
				!session.isRetrying &&
				!session.isSessionTransitioning &&
				!session.hasAdmittedSubmission &&
				!session.hasPendingAsyncWork() &&
				session.queuedMessageCount === 0 &&
				!this.ctx.hasPendingSubmission()
			) {
				break;
			}
			await Bun.sleep(10);
		}
		if (!continuesConversation(this.ctx.sessionManager, request)) {
			// Switched sessions or navigated the tree (both may reuse this `AgentSession`): nothing queued
			// for the old position may compact or run here.
			this.ctx.restoreCompactionQueueToEditor();
			return;
		}
		this.ctx.yieldCompaction = undefined;
		// The request leaves; its position stays with the follow-ups it held until they flush.
		this.ctx.compactionQueueOrigin = { sessionId: request.sessionId, leafId: request.leafId };
		this.ctx.updatePendingMessagesDisplay();
		if (session.isCompacting) {
			// Another pass (auto, or an extension's `ctx.compact()`) already compacts.
			this.ctx.showStatus("Skipped queued compaction: context is already compacting");
			while (session.isCompacting) {
				await Bun.sleep(10);
			}
			await this.ctx.flushCompactionQueue({ willRetry: false });
			return;
		}
		// `executeCompaction` calls the hook right before it flushes the queue; "Nothing to compact"
		// returns before both, so the held follow-ups are released here instead.
		let compactionFlushes = false;
		await this.handleCompactCommand(request.instructions, request.mode, () => {
			compactionFlushes = true;
		});
		if (!compactionFlushes) await this.ctx.flushCompactionQueue({ willRetry: false });
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content,
	 * `images` strips image blocks, and `thinking` drops the thinking blocks the
	 * request rebuilds from them, keeping the turns it replays natively (they
	 * are reported as kept and the transcript is left alone). Rebuilds the chat
	 * and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const dropped =
			result.toolResultsDropped +
			result.blocksDropped +
			(result.imagesDropped ?? 0) +
			(result.thinkingBlocksDropped ?? 0);
		if (dropped === 0) {
			// Replayed thinking was left in place: nothing to rebuild, but say so.
			this.ctx.showStatus((result.thinkingBlocksKept ?? 0) > 0 ? formatShakeSummary(result) : "Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
		readerModel?: Model,
	): Promise<CompactionOutcome> {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const cancelHint = `(${appKey(this.ctx.keybindings, "app.interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		const compactionStartMs = Date.now();
		compactingLoader.setWorkingRow(
			() => ({
				label: isAuto ? "Auto-compacting context…" : "Compacting context…",
				startedAt: compactionStartMs,
				variant: { kind: "compaction" },
				interruptKey: this.ctx.maintenanceInterruptKey(),
			}),
			() => this.ctx.interruptFromPointer(),
		);
		this.ctx.statusContainer.addChild(compactingLoader);
		this.ctx.ui.requestRender();

		let outcome: CompactionOutcome = "ok";
		try {
			const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
			const baseOptions =
				customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
					? customInstructionsOrOptions
					: undefined;
			// The slash path passes `mode` positionally; the extension path carries
			// it inside the options object. Either source wins over no mode.
			const effectiveMode = mode ?? baseOptions?.mode;
			const options =
				baseOptions || effectiveMode || readerModel
					? {
							...baseOptions,
							...(effectiveMode ? { mode: effectiveMode } : {}),
							...(readerModel ? { readerModel } : {}),
						}
					: undefined;
			await this.ctx.session.compact(instructions, options);

			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });

			this.ctx.statusLine.invalidate();
			// Same pairing as the auto-compaction arm in event-controller: the
			// rebuild clears the container's emission ledger, so every block
			// re-emits on this frame while the previous copy is still in native
			// scrollback — without a clear the collapse-disabled path appends a
			// duplicate transcript, exactly as `/compact` reproduced (#12140).
			this.ctx.ui.requestRender(true, { clearScrollback: true });
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}
		if (this.ctx.session.isCompacting) {
			this.ctx.showWarning("Wait for context compaction to finish or cancel it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const handoffLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`Generating handoff… (${appKey(this.ctx.keybindings, "app.interrupt")} to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(handoffLoader);
		this.ctx.ui.requestRender();

		try {
			// Handoff generation runs as a oneshot request; the document is then
			// committed as a compaction entry on this session.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the session, which now shows the handoff compaction divider.
			this.ctx.clearTransientSessionUi();
			await this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", `${theme.status.success} Context handed off and compacted in place`)}`,
					1,
					1,
				),
			]);
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// `session.handoff()` normalizes genuine cancellations to this exact message; a
			// provider error (even one named AbortError) is re-thrown verbatim so it surfaces
			// as a real failure instead of a false "cancelled".
			if (message === "Handoff cancelled") {
				this.ctx.showError("Handoff cancelled");
			} else {
				// Persist the real failure so it is debuggable after the transient
				// TUI error clears (#7993).
				logger.error("Handoff failed", { error: message });
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			this.#finishHandoffUi(handoffLoader);
			await this.ctx.flushCompactionQueue({ willRetry: false });
		}
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	#finishHandoffUi(handoffLoader: Loader): void {
		handoffLoader.stop();
		// A retry/compaction event may replace the handoff overlay while transcript
		// replay yields. Preserve it only while it still owns the status row; a
		// reference to a loader disposed earlier must not retain the handoff overlay.
		const maintenanceLoader = this.ctx.autoCompactionLoader ?? this.ctx.retryLoader;
		if (maintenanceLoader && this.ctx.statusContainer.children.includes(maintenanceLoader)) return;
		this.ctx.statusContainer.disposeChildren();
		// `disposeChildren()` disposed any working loader mounted by a delayed
		// `agent_start` during transcript replay, which stops its animation timer.
		// Drop the now-frozen reference so the reconciler below never reattaches it
		// (`ensureLoadingAnimation()` only re-adds an existing instance, never
		// restarts it).
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.session.isStreaming) {
			// A new turn won the race with handoff cleanup; mount a fresh, running
			// loader for it now that the stale reference is cleared.
			this.ctx.ensureLoadingAnimation();
		}
	}
}

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, (job.endTime ?? now) - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}

function truncateJobLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return "…";

	let out = "";
	for (const char of label) {
		const next = `${out}${char}`;
		if (visibleWidth(`${next}…`) > maxWidth) break;
		out = next;
	}

	return `${out}…`;
}
