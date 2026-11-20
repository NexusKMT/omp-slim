import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { extractLastCodeBlock, extractLastCommand, extractLastLink } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import { formatDumpArchiveReport } from "../session/session-dump-format";
import { copyToClipboard } from "../utils/clipboard";
import { openPath } from "../utils/open";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SESSION_ACTION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
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
