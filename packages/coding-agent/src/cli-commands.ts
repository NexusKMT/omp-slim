/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";
import { flagConsumesValue } from "./cli/flag-tables";
import { launchHelp } from "./commands/launch-help";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default), help: launchHelp },
	{
		name: "acp",
		load: () => import("./commands/acp").then(m => m.default),
		help: { description: "Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio" },
	},
	{
		name: "auth-broker",
		load: () => import("./commands/auth-broker").then(m => m.default),
		help: { description: "Manage the omp auth-broker (credential vault)" },
	},
	{
		name: "auth-gateway",
		load: () => import("./commands/auth-gateway").then(m => m.default),
		help: { description: "Run an auth-gateway forward proxy backed by the configured broker" },
	},
	{
		name: "agents",
		load: () => import("./commands/agents").then(m => m.default),
		help: { description: "Manage bundled task agents" },
	},
	{
		name: "bench",
		load: () => import("./commands/bench").then(m => m.default),
		help: {
			description: "Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s)",
		},
	},
	{
		name: "cleanse",
		load: () => import("./commands/cleanse").then(m => m.default),
		help: { description: "Detect and fix project diagnostics with weighted parallel subagents" },
	},
	{
		name: "commit",
		load: () => import("./commands/commit").then(m => m.default),
		help: { description: "Generate a commit message and update changelogs" },
	},
	{
		name: "completions",
		load: () => import("./commands/completions").then(m => m.default),
		help: { description: "Print a shell completion script (bash, zsh, or fish)" },
	},
	{ name: "__complete", load: () => import("./commands/complete").then(m => m.default), help: { hidden: true } },
	{
		name: "config",
		load: () => import("./commands/config").then(m => m.default),
		help: { description: "Manage configuration settings" },
	},
	{
		name: "dry-balance",
		load: () => import("./commands/dry-balance").then(m => m.default),
		help: { description: "Dry-run OAuth account balancing across random session ids" },
	},
	{
		name: "gc",
		load: () => import("./commands/gc").then(m => m.default),
		help: { description: "Run storage garbage collection" },
	},
	{
		name: "grep",
		load: () => import("./commands/grep").then(m => m.default),
		help: { description: "Test grep tool" },
	},
	{
		name: "gallery",
		load: () => import("./commands/gallery").then(m => m.default),
		help: { description: "Preview tool renderers across streaming, in-progress, success, and failure states" },
	},
	{
		name: "grievances",
		load: () => import("./commands/grievances").then(m => m.default),
		help: { description: "View, clean, or push reported tool issues (auto-QA grievances)" },
	},
	{
		name: "install",
		load: () => import("./commands/install").then(m => m.default),
		help: { description: "Install or link an extension package (alias of `plugin install`/`plugin link`)" },
	},
	{
		name: "join",
		load: () => import("./commands/join").then(m => m.default),
		help: { description: "Join a shared collab session (same as /join)" },
	},
	{
		name: "models",
		load: () => import("./commands/models").then(m => m.default),
		help: { description: "List, search, and refresh available models" },
	},
	{
		name: "plugin",
		load: () => import("./commands/plugin").then(m => m.default),
		help: { description: "Manage plugins (install, uninstall, list, etc.)" },
	},
	{
		name: "say",
		load: () => import("./commands/say").then(m => m.default),
		help: { description: "Synthesize text with the local TTS engine and play it through the speakers" },
	},
	{
		name: "setup",
		load: () => import("./commands/setup").then(m => m.default),
		help: { description: "Run onboarding setup or install dependencies for optional features" },
	},
	{
		name: "shell",
		load: () => import("./commands/shell").then(m => m.default),
		help: { description: "Interactive shell console" },
	},
	{
		name: "read",
		load: () => import("./commands/read").then(m => m.default),
		help: { description: "Show what the read tool will return for a path, URL, or internal URI" },
	},
	{
		name: "ssh",
		load: () => import("./commands/ssh").then(m => m.default),
		help: { description: "Manage SSH host configurations" },
	},
	{
		name: "stats",
		load: () => import("./commands/stats").then(m => m.default),
		help: { description: "View usage statistics" },
	},
	{
		name: "update",
		load: () => import("./commands/update").then(m => m.default),
		help: { description: "Check for and install updates" },
	},
	{
		name: "usage",
		load: () => import("./commands/usage").then(m => m.default),
		help: { description: "Show provider usage limits for every authenticated account" },
	},
	{
		name: "tiny-models",
		load: () => import("./commands/tiny-models").then(m => m.default),
		help: { description: "Download tiny local models (session titles + memory)" },
	},
	{
		name: "token",
		load: () => import("./commands/token").then(m => m.default),
		help: { description: "Get the API key or OAuth token for a provider" },
	},
	{
		name: "ttsr",
		load: () => import("./commands/ttsr").then(m => m.default),
		help: { description: "Inspect and test Time-Traveling Stream Rules (TTSR)" },
	},
	{
		name: "worktree",
		load: () => import("./commands/worktree").then(m => m.default),
		aliases: ["wt"],
		help: { description: "List or clear agent-managed git worktrees (~/.omp/wt)" },
	},
	{
		name: "search",
		load: () => import("./commands/web-search").then(m => m.default),
		aliases: ["q"],
		help: { description: "Test web search providers" },
	},
];

// Documented-looking plugin/marketplace verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `omp marketplace add
// xyz` to `omp launch marketplace add xyz`, silently forwarding the argv to the
// model as a prompt instead of managing plugins (#4845; same class as the
// `list`/`remove` leak fixed in #2935 and the `install` leak in #1496/#1498).
// The real commands live under `omp plugin <action>`; each entry maps a verb to
// a hint pointing there. See {@link reservedTopLevelWordMessage} for when a hint
// fires vs. when the argv still falls through to `launch`.
const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
	list: '`omp list` is not a top-level command. Use `omp plugin list` to list installed plugins, or run `omp launch list` if you meant to send "list" as a prompt.',
	remove:
		'`omp remove` is not a top-level command. Use `omp plugin uninstall <name>` to remove a plugin, or run `omp launch remove` if you meant to send "remove" as a prompt.',
	uninstall:
		'`omp uninstall` is not a top-level command. Use `omp plugin uninstall <name@marketplace>` to remove a plugin, or run `omp launch uninstall` if you meant to send "uninstall" as a prompt.',
	marketplace:
		'`omp marketplace` is not a top-level command. Use `omp plugin marketplace <add|remove|update|list>` to manage marketplaces, or run `omp launch marketplace` if you meant to send "marketplace" as a prompt.',
	discover:
		'`omp discover` is not a top-level command. Use `omp plugin discover [marketplace]` to browse available plugins, or run `omp launch discover` if you meant to send "discover" as a prompt.',
	upgrade:
		'`omp upgrade` is not a top-level command. Use `omp plugin upgrade [name@marketplace]` to upgrade plugins, or run `omp launch upgrade` if you meant to send "upgrade" as a prompt.',
	enable:
		'`omp enable` is not a top-level command. Use `omp plugin enable <name@marketplace>` to enable a plugin, or run `omp launch enable` if you meant to send "enable" as a prompt.',
	disable:
		'`omp disable` is not a top-level command. Use `omp plugin disable <name@marketplace>` to disable a plugin, or run `omp launch disable` if you meant to send "disable" as a prompt.',
};

// Sub-actions that make `omp marketplace <sub>` unambiguously a management
// command even when multi-word (the reporter's `omp marketplace add xyz`,
// #4845). Mirrors the switch in `handleMarketplace` (cli/plugin-cli.ts).
const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

/**
 * Hint for a reserved plugin/marketplace verb used as a top-level command, or
 * `undefined` when the argv should fall through to `launch`.
 *
 * A bare verb (`omp marketplace`) always hints. A multi-word invocation only
 * hints when the arguments follow the documented plugin grammar — a marketplace
 * sub-action (`omp marketplace add …`) or a `name@marketplace` plugin id
 * (`omp uninstall foo@bar`) — so genuine prompts that merely begin with one of
 * these words (`omp list all my files`, `omp upgrade the deps`) still launch.
 *
 * Flags (`-…`) and `@file` arguments in the verb slot are never management
 * commands; those fall through to the default `launch` command.
 */
export function reservedTopLevelWordMessage(argv: readonly string[]): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hint = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hint) return undefined;
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command with the flags preserved, and forward everything else to
 * `launch` (#2970).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front and keep the leading flags as its own
	// argv; the command's parser then applies them. Genuine launch prompts (no
	// trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		return { argv: [argv[subIndex], ...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] };
	}
	return { argv: ["launch", ...argv] };
}
