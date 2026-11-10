import { clearSubmittedText } from "./helpers/draft";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { extractLastCodeBlock, extractLastCommand, extractLastLink } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import { openPath } from "../utils/open";
import { copyToClipboard } from "../utils/clipboard";
import { refreshStatusLine } from "./builtin-modes";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { formatDumpArchiveReport } from "../session/session-dump-format";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SESSION_ACTION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "advisor",
		icon: "advisor",
		description: "Toggle the advisor (reviews each turn using the current model)",
		acpDescription: "Toggle advisor",
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: "Enable the advisor" },
			{ name: "off", description: "Disable the advisor" },
			{ name: "status", description: "Show advisor status" },
			{ name: "dump", description: "Copy the advisor's transcript to clipboard", usage: "[raw]" },
			{ name: "configure", description: "Open the advisor configuration editor (TUI)" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1) return `Advisor: on (${stats.advisors.length} advisors)`;
			if (stats.active && stats.model) return `Advisor: on (${stats.model.provider}/${stats.model.id})`;
			if (stats.configured) return "Advisor: configured, no model";
			return "Advisor: off";
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output("Advisor enabled.");
				} else if (configured) {
					await runtime.output("Advisor setting enabled, but no current model is available.");
				} else {
					await runtime.output("Advisor disabled.");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? "Advisor enabled." : "Advisor setting enabled, but no current model is available.",
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output("Advisor disabled.");
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? "Advisor is not active for this session.");
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					"/advisor configure opens an interactive editor and is only available in the interactive TUI.",
				);
				return commandConsumed();
			}
			return usage("Usage: /advisor [on|off|status|dump [raw]|configure]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus("Advisor enabled.");
				} else if (configured) {
					runtime.ctx.showStatus("Advisor setting enabled, but no current model is available.");
				} else {
					runtime.ctx.showStatus("Advisor disabled.");
				}
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? "Advisor enabled." : "Advisor setting enabled, but no current model is available.",
				);
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("Advisor disabled.");
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /advisor [on|off|status|dump [raw]|configure]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "trace",
		icon: "stats",
		description: "Open this session's trace in the stats dashboard",
		handle: async (_command, runtime) => {
			const sessionFile = runtime.session.sessionFile;
			if (!sessionFile) {
				await runtime.output("No session file yet — send a message first.");
				return commandConsumed();
			}
			try {
				// Lazy: the stats dashboard (server + sqlite) loads on demand only,
				// matching src/cli/stats-cli.ts, to keep CLI startup fast.
				const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
				const { hostname, port } = await startServer();
				const url = `${formatStatsDashboardUrl(hostname, port)}/#/traces?s=${encodeURIComponent(sessionFile)}`;
				await runtime.output(url);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to open trace: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleTraceCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "dump",
		icon: "clipboard",
		description: "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
		acpDescription: "Return full transcript as plain text, with LLM request JSON path",
		acpInputHint: "[all|anon]",
		subcommands: [
			{
				name: "all",
				description: "Write a zip with the main transcript, LLM request JSON, and one file per subagent",
			},
			{
				name: "anon",
				description: "Write a zip of anonymized session JSONL (contents redacted, metadata kept) plus subagents",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all" || verb === "anon") {
				const archive =
					verb === "all"
						? await runtime.session.dumpSessionArchiveToTmpDir()
						: await runtime.session.dumpAnonymizedArchiveToTmpDir();
				if (!archive) {
					await runtime.output("No messages to dump yet.");
					return commandConsumed();
				}
				await runtime.output(formatDumpArchiveReport(archive).join("\n"));
				return commandConsumed();
			}
			if (verb) return usage("Usage: /dump [all|anon]", runtime);
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("No messages to dump yet.");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM request JSON: ${sidecarPath}`,
					"This file persists on disk and may contain raw context/secrets — treat accordingly.",
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all") await runtime.ctx.handleDumpAllCommand();
			else if (verb === "anon") await runtime.ctx.handleDumpAnonCommand();
			else if (verb) runtime.ctx.showStatus("Usage: /dump [all|anon]");
			else await runtime.ctx.handleDumpCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "copy",
		icon: "copy",
		description: "Pick text or code from the conversation to copy",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("No code block to copy.");
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("Copied code block to clipboard");
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("No command to copy.");
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`Copied ${lastCommand.kind === "bash" ? "bash command" : "eval code"} to clipboard`);
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "link" || arg === "url") {
				const link = extractLastLink(runtime.ctx.session.messages);
				if (!link) {
					runtime.ctx.showStatus("No link to copy.");
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(link.href);
				runtime.ctx.showStatus("Copied link to clipboard");
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /copy [code|cmd|link]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "open",
		icon: "globe",
		description: "Open the last link from the conversation in your browser (or pick one with /copy)",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "link" && arg !== "url") {
				runtime.ctx.showStatus(
					`Usage: /open [link]  (pick a specific link: /copy, ${formatKeyHint("right")} blocks, ${formatKeyHint("o")})`,
				);
				clearSubmittedText(runtime);
				return;
			}
			const link = extractLastLink(runtime.ctx.session.messages);
			if (!link) {
				runtime.ctx.showStatus("No link to open.");
				clearSubmittedText(runtime);
				return;
			}
			openPath(link.href);
			runtime.ctx.showStatus(`Opening ${link.href}`);
			clearSubmittedText(runtime);
		},
	},
];
