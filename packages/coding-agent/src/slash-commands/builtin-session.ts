import { clearSubmittedText } from "./helpers/draft";

import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import type { AgentSession } from "../session/agent-session";

import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import { shortenEmbeddedPaths, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { handleMcpAcp } from "./helpers/mcp";
import { markdownFenceFor } from "../utils/markdown-fence";
import { openLocalFileInEditor } from "../modes/local-file-editor";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";

import {
	launchStatsDashboard,
	parseStatsDashboardArgs,
	type StatsDashboardArgs,
	type StatsDashboardLaunchResult,
} from "./helpers/stats-dashboard";
import { StatsNotice } from "@oh-my-pi/pi-tui/overlays/stats-notice";
import { handleTodoAcp } from "./helpers/todo";

import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

/**
 * `/jobs kill <id>|all`: cancel one running background job this session owns,
 * or every running one. Routes through the same owner-scoped
 * `AgentSession.cancelAsyncJob` the jobs sheet's `x`-to-cancel and
 * `proc://<id>/kill` use, so it can only touch jobs `/jobs` lists.
 */
async function handleJobsKillCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	const target = arg.trim();
	if (!target) {
		await output("Usage: /jobs kill <id>|all");
		return;
	}
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 0 });
	if (!snapshot) {
		await output("Async background jobs are unavailable in this session.");
		return;
	}
	if (target === "all") {
		let cancelled = 0;
		for (const job of snapshot.running) {
			if (session.cancelAsyncJob(job.id)) cancelled += 1;
		}
		await output(
			cancelled === 0
				? "No running background jobs to cancel."
				: `Cancelled ${cancelled} background job${cancelled === 1 ? "" : "s"}.`,
		);
		return;
	}
	const safeTarget = truncateToWidth(sanitizeText(target).replace(/\s+/g, " ").trim(), 60);
	if (!snapshot.running.some(job => job.id === target)) {
		await output(`No running background job with id "${safeTarget}".`);
		return;
	}
	await output(
		session.cancelAsyncJob(target)
			? `Cancelled background job ${safeTarget}.`
			: `Could not cancel background job ${safeTarget}.`,
	);
}

/**
 * Start (or reuse) the stats dashboard for this session. The Frustration page
 * judges through this session's settings and registry; its cost lands on this
 * session's ledger.
 */
function launchSessionStatsDashboard(
	args: StatsDashboardArgs,
	owner: Pick<SlashCommandRuntime, "settings" | "session" | "sessionManager">,
): Promise<StatsDashboardLaunchResult> {
	const judge = resolveJudge({
		settings: owner.settings,
		registry: owner.session.modelRegistry,
		sessionId: owner.session.sessionId,
		purpose: "stats_frustration",
		onUsage: journalJudgmentUsage(owner.sessionManager),
		telemetry: owner.session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	return launchStatsDashboard(args, async () => judge);
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "expand", description: "Show every phase and task in the HUD" },
			{ name: "collapse", description: "Restore the bounded HUD preview" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Todos: none";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Todos: ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "session",
		icon: "session",
		description: "Session management commands",
		acpDescription: "Show or configure the current session",
		acpInputHint: "[info|delete]",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}

			return usage("Usage: /session [info|delete]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				clearSubmittedText(runtime);
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}

			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus("Usage: /session [info|delete]");
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		acpInputHint: "[full|kill <id>|kill all]",
		subcommands: [
			{ name: "full", description: "Show full, untruncated command lines" },
			{ name: "kill", description: "Cancel a running background job", usage: "<id>|all" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "Jobs: none";
			return `Jobs: ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			if (rest || (verb && verb !== "full")) return usage("Usage: /jobs [full|kill <id>|kill all]", runtime);
			const full = verb === "full";
			if (full) runtime.session.requestJobCaptions();
			const tree = runtime.session.getAsyncJobTree();
			if (!tree || (tree.running.length === 0 && tree.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and briefly after (until their result is delivered; at most ~5 minutes).)",
				);
				return commandConsumed();
			}
			// One fenced block keeps the tree rails aligned; the fence outgrows any run inside a command.
			const now = Date.now();
			const rows: string[] = [];
			for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
				const guide = jobTreeGuide(row, theme);
				if (row.kind === "agent") {
					rows.push(`${guide}${row.agent.id}`);
					continue;
				}
				const { job } = row;
				// A spawned subagent's task job takes the agent's id as its id and label: name it once.
				const agent = row.agent && row.agent.id !== job.id ? ` ${row.agent.id}` : "";
				rows.push(
					`${guide}[${job.id}] ${job.type} (${job.status}) — ${formatCoarseDuration((job.endTime ?? now) - job.startTime)}${agent}`,
				);
				// What the job is for leads; full mode follows it with what the command does and the whole command.
				const lines = full ? [job.intent, job.caption, job.command ?? job.label] : [job.intent ?? job.label];
				const indent = jobTreeIndent(row, theme);
				for (const entry of lines) {
					if (!entry) continue;
					const text = shortenEmbeddedPaths(sanitizeText(entry));
					if (text === job.id) continue;
					for (const line of text.split("\n")) rows.push(`${indent}${line}`);
				}
			}
			const body = rows.join("\n");
			const fence = markdownFenceFor(body);
			await runtime.output(
				["Background Jobs", `Running: ${tree.running.length}`, "", `${fence}text`, body, fence].join("\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
			} else if (rest || (verb && verb !== "full")) {
				runtime.ctx.showStatus("Usage: /jobs [full|kill <id>|kill all]");
			} else {
				await runtime.ctx.handleJobsCommand({ full: verb === "full" });
			}
			clearSubmittedText(runtime);
		},
	},

	{
		name: "stats",
		icon: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchSessionStatsDashboard(parsed, runtime);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
				// Mark the failure like `usage()` does, for hosts that report a
				// failed builtin (print mode does not dispatch `/stats`).
				return commandConsumed({ failed: true });
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) {
				ctx.showStatus(parsed.error);
				return;
			}
			try {
				const result = await launchSessionStatsDashboard(parsed, ctx);
				ctx.presentCommandOutput(new StatsNotice(result.message, result.url));
			} catch (error) {
				ctx.showError(`Stats dashboard failed: ${errorMessage(error)}`);
			}
		},
	},
	{
		name: "changelog",
		icon: "news",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full|last [N]]",
		subcommands: [
			{ name: "full", description: "Show complete changelog" },
			{ name: "last", description: "Show the last N releases (default 1)", usage: "[N]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const view = parseChangelogView(command.args);
			if ("error" in view) return usage(view.error, runtime);
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const entriesToShow = selectChangelogEntries(allEntries, view);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleChangelogCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "tools",
		icon: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? "Tools: none available" : `Tools: ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "context",
		icon: "context",
		description: "Browse context usage and detailed content",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return "Context: unavailable";
			return `Context: ${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "agents",
		icon: "agents",
		description: "Manage agent personas, enablement, and advisors",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "git",
		icon: "branch",
		description: "Open the git UI (split diff viewer, staging, commit composer)",
		inlineHint: "[revision]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			runtime.ctx.showGitUi(command.args.trim() || undefined);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "local",
		icon: "pencil",
		description: "Open a session local:// file in $EDITOR (picker when no name given)",
		inlineHint: "[name]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await openLocalFileInEditor(runtime.ctx, command.args);
		},
	},
	{
		name: "hub",
		aliases: ["subagents"],
		icon: "agents",
		description: "Open the live Agent Hub (subagents, including finished ones)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentHub({ initialSection: "activity" });
			clearSubmittedText(runtime);
		},
	},
	{
		name: "branch",
		aliases: ["rewind"],
		icon: "branch",
		description: "Rewind to a previous message, keeping the old path as a branch",
		handleTui: (_command, runtime) => {
			runtime.ctx.showUserMessageSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "fork",
		icon: "branch",
		description: "Fork this session, or open it in a multiplexer pane or window",
		subcommands: [
			{ name: "pane", description: "Open the fork in a new terminal pane" },
			{ name: "window", description: "Open the fork in a new multiplexer window" },
			{ name: "tab", description: "Alias for window" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			let placement: "pane" | "window" | undefined;
			if (args) {
				const [keyword, ...extra] = args.split(/\s+/);
				if (extra.length > 0) {
					clearSubmittedText(runtime);
					runtime.ctx.showError("Usage: /fork [pane|window|tab]");
					return;
				}
				switch (keyword?.toLowerCase()) {
					case "pane":
						placement = "pane";
						break;
					case "window":
					case "tab":
						placement = "window";
						break;
					default:
						clearSubmittedText(runtime);
						runtime.ctx.showError("Usage: /fork [pane|window|tab]");
						return;
				}
			}
			clearSubmittedText(runtime);
			if (placement) await runtime.ctx.handleForkCommand(placement);
			else await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			clearSubmittedText(runtime);
		},
	},

	{
		name: "mcp",
		icon: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];
