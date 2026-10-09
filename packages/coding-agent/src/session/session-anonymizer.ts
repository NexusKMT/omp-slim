/**
 * Allowlist anonymizer for session JSONL files.
 *
 * Every field is exported by an explicit rule in {@link FIELD_RULES}: usage, timing, models, ids,
 * tool names, and other metadata omp writes are kept; turn contents become size-annotated markers;
 * paths become mock paths; shell commands keep program names and flags. A field without a rule —
 * and every payload omp does not define (extension/MCP data, non-built-in tool details or args,
 * `eval` display output) — becomes an opaque marker under a tokenized key. Nothing is kept because
 * of how a value looks.
 *
 * One instance carries a single token table, so equal originals map to equal tokens across every
 * line and file it processes. Path segments and placeholders share the index space:
 * `name: "Probe"` → `PLACEHOLDER_7` and `agent://Probe` → `agent://seg7`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { getBundledAgentsMap } from "../task/agents";
import { BUILTIN_TOOL_NAMES, isMCPToolName } from "../tools/builtin-names";
import { lexShellCommand } from "../tools/shell-tokenize";
import type { SessionEntry, SessionHeader } from "./session-entries";
import { collectSubSessions, type SubSession } from "./sub-sessions";

type JsonObject = Record<string, unknown>;

/** Shown wherever an anonymized export is written: the redaction is rule-based, not a guarantee. */
export const ANONYMIZED_REVIEW_NOTE =
	"Turn contents and error text are redacted and paths/literals replaced; metadata such as model names is kept — review before sharing.";

/**
 * Export rule for a field omp writes. Numbers, booleans, and null under any rule except `opaque`
 * and `label` are kept (counts, sizes, timings, flags).
 * - `num`: numeric/flag field; a string there is redacted.
 * - `time`: ISO timestamp or epoch ms.
 * - `enum`/`identity`: omp- or provider-written identifier (stop reason, model id); other shapes are tokenized.
 * - `agent`/`spawns`: bundled agent names kept, custom agent names tokenized.
 * - `id`: machine-minted ids kept; named ids mapped like the `agent://` segment they mirror.
 * - `path`/`cmd`: mock paths / shell rewrite. `text`: redaction marker. `label`: placeholder.
 * - `error`: redacted except a leading HTTP status.
 * - `tool`/`name`/`customType`: code-chosen identifiers kept; MCP (user-configured) names tokenized.
 * - `content`: string or content blocks. `struct`: nested omp structure.
 * - `args`/`details`/`data`: tool-call args, tool-result details, custom-entry data — walked only
 *   for built-in tools / omp's own entries, otherwise opaque.
 * - `opaque`: replaced whole by a marker.
 */
type Rule =
	| "num"
	| "time"
	| "enum"
	| "identity"
	| "agent"
	| "spawns"
	| "id"
	| "path"
	| "cmd"
	| "text"
	| "label"
	| "error"
	| "tool"
	| "name"
	| "customType"
	| "content"
	| "struct"
	| "args"
	| "details"
	| "data"
	| "opaque";

function fields(rule: Rule, keys: readonly string[]): Record<string, Rule> {
	return Object.fromEntries(keys.map(key => [key, rule]));
}

/** Every field omp writes in session records, messages, content blocks, and built-in tool details. */
const FIELD_RULES: Record<string, Rule> = {
	...fields("num", [
		"version",
		"resolvedModelIsFallback",
		"display",
		"synthetic",
		"steering",
		"liveSteered",
		"userInitiated",
		"credentialId",
		"isError",
		"useless",
		"prunedAt",
		"exitCode",
		"cancelled",
		"truncated",
		"excludeFromContext",
		"tokensBefore",
		"tokensAfter",
		"fromExtension",
		"readOnly",
		"restrictToolNames",
		"readSummarize",
		"isolated",
		"streamIndex",
		"errorStatus",
		"errorId",
		"requestBodyReadTimeoutFullReplay",
		"duration",
		"ttft",
		"dt",
		"exactTail",
		"lineCount",
		"messageIndex",
		"attempt",
		"promptTokens",
		"nonMessageTokens",
		"historyRewriteTokensRemoved",
		"compactionEpoch",
		"lastMessageTimestamp",
		"historyRewriteAt",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"reasoningTokens",
		"total",
		"ephemeral1h",
		"ephemeral5m",
		"thresholdPercent",
		"thresholdTokens",
		"totalLines",
		"startLine",
		"lineNumbers",
		"fileSize",
		"outputBytes",
		"totalBytes",
		"outputLines",
		"start",
		"end",
		"fileCount",
		"nextOffset",
		"lastLinePartial",
		"firstLineExceedsLimit",
		"matchCount",
		"count",
		"timeoutSeconds",
		"wallTimeMs",
		"maxBytes",
		"maxColumn",
		"firstChangedLine",
		"elidedLines",
		"elidedBytes",
		"artifactElidedBytes",
		"durationMs",
		"totalDurationMs",
		"snapshotsPruned",
		"index",
		"lines",
		"elidedSpans",
		"perFileLimitReached",
		"linesTruncated",
		"fileLimitReached",
		"pagedSource",
		"toolCount",
		"requests",
		"tokens",
		"isDirectory",
		"timedOut",
		"pid",
		"resultLimitReached",
		"reached",
		"suggestion",
		"restartCount",
		"persist",
		"detached",
		"ready",
		"completionPercent",
		"errored",
		"__interrupted",
		"__synthetic",
		"executed",
		"interrupted",
		"conflictCount",
		"madeExecutable",
		"chars",
		"multi",
		"wakeRelay",
		"partialLine",
		"requestedTimeoutSeconds",
	]),
	...fields("time", [
		"timestamp",
		"startedAt",
		"recordedAt",
		"updatedAt",
		"createdAt",
		"completedAt",
		"recoveredAt",
		"exitedAt",
		"readyAt",
		"interruptedAt",
		"ts",
	]),
	...fields("enum", [
		"type",
		"role",
		"titleSource",
		"thinkingLevel",
		"configured",
		"serviceTier",
		"purpose",
		"stopReason",
		"source",
		"trigger",
		"attribution",
		"method",
		"modelRole",
		"outputSchemaMode",
		"mimeType",
		"detail",
		"kind",
		"status",
		"recovery",
		"category",
		"reason",
		"phase",
		"clearAt",
		"effort",
		"topLevel",
		"tail",
		"disabledFeatures",
		"mode",
		"truncatedBy",
		"direction",
		"unit",
		"contentType",
		"op",
		"state",
		"language",
		"languages",
		"agentSource",
		"execution",
		"outcome",
		"resolvedThinkingLevel",
		"storage",
		"server",
		"customWireName",
		"visibility",
	]),
	...fields("identity", [
		"api",
		"provider",
		"model",
		"resolvedModel",
		"upstreamProvider",
		"upstreamModel",
		"advisor",
		"selector",
		"resolvedModelIdentity",
	]),
	agent: "agent",
	spawns: "spawns",
	...fields("id", [
		"id",
		"parentId",
		"toolCallId",
		"call_id",
		"responseId",
		"firstKeptEntryId",
		"providerReplayThroughEntryId",
		"fromId",
		"targetId",
		"sourceEntryId",
		"itemId",
		"turn_id",
		"artifactId",
		"jobId",
		"agentUrlId",
		"owner",
		"replyTo",
		"from",
		"to",
	]),
	...fields("path", [
		"cwd",
		"path",
		"paths",
		"file",
		"files",
		"file_path",
		"additionalDirectories",
		"parentSession",
		"previousSessionFiles",
		"scopePath",
		"searchPath",
		"resolvedPath",
		"displayTarget",
		"url",
		"finalUrl",
		"missingPaths",
		"fullOutputPath",
		"readFiles",
		"modifiedFiles",
		// `meta.source.value` of a read: the path or URL it came from.
		"value",
	]),
	command: "cmd",
	...fields("text", [
		"text",
		"thinking",
		"summary",
		"shortSummary",
		"systemPrompt",
		"task",
		"output",
		"code",
		"warning",
		"note",
		"rawBlock",
		"filesText",
		"diff",
		"oldText",
		"newText",
		"resultText",
		"errorText",
		"error",
		"question",
		"customInput",
		"preview",
		"assignment",
		"log",
		"messages",
		"body",
	]),
	...fields("label", ["title", "previousTitle", "label", "injectedRules", "intent", "emoji", "nf"]),
	...fields("error", ["errorMessage", "explanation", "errorClassificationMessage", "upstreamError"]),
	...fields("tool", ["toolName", "tools", "declared", "deferred", "active"]),
	name: "name",
	customType: "customType",
	content: "content",
	...fields("struct", [
		"message",
		"usage",
		"cost",
		"cttl",
		"card",
		"contextSnapshot",
		"retryRecovery",
		"supersededBy",
		"stopDetails",
		"requestControls",
		"inputTransformations",
		"providerPayload",
		"items",
		"compactionThreshold",
		"toolChanges",
		"meta",
		"truncation",
		"limits",
		"columnTruncated",
		"shownRange",
		"headRange",
		"tailRange",
		"resultLimit",
		"async",
		"service",
		"daemon",
		"daemons",
		"jobs",
		"progress",
		"cells",
		"fileMatches",
		"fileReplacements",
		"perFileResults",
		"displayContent",
		"diagnostics",
		"receipts",
		"waited",
	]),
	...fields("args", ["arguments", "partialArgs", "args", "input"]),
	details: "details",
	data: "data",
	// Known fields whose payload is never useful or never safe: keep the key, redact the value.
	...fields("opaque", [
		"textSignature",
		"thinkingSignature",
		"thoughtSignature",
		"encrypted_content",
		"encryptedContent",
		"signature",
		"hash",
		"preserveData",
		"outputSchema",
		"retryFallback",
		"workPoolYieldItems",
		"providerPromptCacheKey",
		"providerFile",
		"providerMetadata",
		"toolCallAbortMessages",
		"fallbackCreditHandle",
		"annotations",
		"logprobs",
		"retainedFiles",
		"metadata",
		"internal_chat_message_metadata_passthrough",
		"block",
		"jsonOutputs",
		"structured",
		"xdev",
		"response",
		"results",
		"projectAgentsDir",
		"recentTools",
		"recentOutput",
		"statusEvents",
		"options",
		"selectedOptions",
		"phases",
		"tasks",
		"completedTasks",
		"proc",
		"cfg",
		"terminalRows",
		"notes",
	]),
};

/** Built-in tool argument keys holding prose: redacted rather than tokenized. */
const TEXT_ARG_KEYS: Record<string, true> = {
	content: true,
	text: true,
	code: true,
	task: true,
	context: true,
	prompt: true,
	message: true,
	body: true,
	input: true,
	summary: true,
	description: true,
	old_text: true,
	new_text: true,
};

/** Path/URI keys not covered by {@link PATH_KEY}. */
const PATH_KEYS: Record<string, true> = {
	file_path: true,
	dir: true,
	directory: true,
	parentSession: true,
	rename: true,
	url: true,
	uri: true,
};

/**
 * Option values of built-in tools and built-in tool details, kept only when listed. An extension may
 * shadow a built-in tool name and the transcript does not record provenance, so a built-in-looking
 * name never lets an arbitrary value through: unlisted values become placeholders.
 */
const TOOL_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
	op: new Set([
		"init",
		"start",
		"done",
		"drop",
		"rm",
		"append",
		"update",
		"block",
		"wait",
		"jobs",
		"send",
		"stop",
		"cancel",
		"logs",
		"view",
		"delete",
		"list",
		"kill",
	]),
	language: new Set(["py", "js", "python", "javascript", "typescript", "ts"]),
	languages: new Set(["py", "js", "python", "javascript", "typescript", "ts"]),
	recency: new Set(["day", "week", "month", "year"]),
	case: new Set(["smart", "sensitive", "insensitive"]),
	status: new Set([
		"complete",
		"completed",
		"running",
		"success",
		"pending",
		"error",
		"failed",
		"cancelled",
		"skipped",
		"done",
		"aborted",
	]),
	direction: new Set(["head", "middle", "tail"]),
	truncatedBy: new Set(["lines", "bytes", "middle"]),
	unit: new Set(["bytes", "chars", "lines"]),
	type: new Set(["path", "internal", "url", "file", "directory", "task", "bash"]),
	state: new Set(["running", "ready", "exited", "starting", "failed", "stopped"]),
	kind: new Set(["url", "file", "directory"]),
	method: new Set([
		"text",
		"json",
		"failed",
		"native",
		"raw",
		"image",
		"jina",
		"trafilatura",
		"md-suffix",
		"content-negotiation",
		"alternate-feed",
		"alternate-markdown",
		"github-pr",
		"github-repo",
		"github-issue",
		"github-raw",
		"github-commit",
		"github-tree",
		"twitter-nitter",
	]),
	source: new Set(["interrupt_skipped", "assistant_stop_aborted", "assistant_stop_error"]),
	execution: new Set(["started", "completed"]),
	storage: new Set(["session", "file"]),
	agentSource: new Set(["bundled", "user", "project"]),
	modelRole: new Set(["default", "smol", "slow", "plan", "vision", "commit"]),
	resolvedThinkingLevel: new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
	outcome: new Set(["injected", "woken", "revived", "failed"]),
	server: new Set(["typescript-native", "typescript-language-server", "rust-analyzer", "gopls", "pyright", "clangd"]),
	contentType: new Set([
		"text/markdown",
		"text/plain",
		"text/html",
		"text/css",
		"text/csv",
		"text/xml",
		"text/javascript",
		"text/typescript",
		"application/json",
		"application/xml",
		"application/pdf",
		"application/octet-stream",
		"application/feed",
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif",
		"image/svg+xml",
		"video/mp4",
		"audio/mpeg",
		"unknown",
	]),
};

/** Built-in tool argument keys holding free-form structures (env maps, schemas, structured output). */
const OPAQUE_ARG_KEYS: Record<string, true> = {
	env: true,
	data: true,
	result: true,
	outputSchema: true,
	schema: true,
	headers: true,
	json: true,
	variables: true,
	params: true,
	payload: true,
};

/** Tool-call argument keys holding search text: always a placeholder, never path-mapped. */
const PATTERN_ARG_KEYS: Record<string, true> = {
	pattern: true,
	query: true,
	regex: true,
	search: true,
	replace: true,
};

/** Content blocks whose `name` field is a tool name. */
const TOOL_CALL_TYPES: Record<string, true> = {
	toolCall: true,
	function_call: true,
	custom_tool_call: true,
	tool_use: true,
	server_tool_use: true,
};

/** Path segments too generic to identify a project; kept verbatim. */
const KEEP_SEGMENTS: Record<string, true> = {
	src: true,
	lib: true,
	test: true,
	tests: true,
	__tests__: true,
	spec: true,
	docs: true,
	doc: true,
	dist: true,
	build: true,
	out: true,
	bin: true,
	scripts: true,
	packages: true,
	crates: true,
	node_modules: true,
	target: true,
	assets: true,
	public: true,
	config: true,
	include: true,
	examples: true,
	tmp: true,
	temp: true,
	Temp: true,
	Users: true,
	home: true,
	AppData: true,
	Local: true,
	Roaming: true,
	index: true,
	main: true,
	mod: true,
	package: true,
	README: true,
	CHANGELOG: true,
	AGENTS: true,
	CLAUDE: true,
	Cargo: true,
	tsconfig: true,
	".git": true,
	".github": true,
	".vscode": true,
	".omp": true,
	".claude": true,
	".cargo": true,
	agent: true,
	sessions: true,
};

/** Programs whose name is kept when they start a shell command. A Set: `then` keys would make a Record thenable. */
const SHELL_COMMANDS = new Set([
	"git",
	"gh",
	"jj",
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"deno",
	"python",
	"python3",
	"py",
	"pip",
	"uv",
	"cargo",
	"rustc",
	"rustup",
	"go",
	"make",
	"cmake",
	"cd",
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"fd",
	"find",
	"sed",
	"awk",
	"sort",
	"uniq",
	"wc",
	"cut",
	"tr",
	"echo",
	"printf",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"rmdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"pwd",
	"which",
	"where",
	"env",
	"export",
	"set",
	"unset",
	"source",
	"test",
	"true",
	"false",
	"sleep",
	"kill",
	"ps",
	"curl",
	"wget",
	"tar",
	"zip",
	"unzip",
	"gzip",
	"docker",
	"kubectl",
	"ssh",
	"scp",
	"rsync",
	"jq",
	"xargs",
	"tee",
	"diff",
	"patch",
	"time",
	"timeout",
	"sudo",
	"nohup",
	"powershell",
	"pwsh",
	"cmd",
	"bash",
	"sh",
	"zsh",
	"nu",
	"omp",
	"gcc",
	"clang",
	"dotnet",
	"java",
	"javac",
	"mvn",
	"gradle",
	"tsc",
	"eslint",
	"prettier",
	"biome",
	"oxlint",
	"vitest",
	"jest",
	"pytest",
	"ruff",
	"mypy",
	"file",
	"stat",
	"du",
	"df",
	"date",
	"whoami",
	"uname",
	"for",
	"do",
	"done",
	"if",
	"then",
	"else",
	"fi",
	"while",
]);

/** Subcommand words of allowlisted programs (`git status`, `cargo build`), kept in first position. */
const SUBCOMMANDS: Record<string, true> = {
	add: true,
	api: true,
	apply: true,
	auth: true,
	bench: true,
	blame: true,
	branch: true,
	build: true,
	check: true,
	checkout: true,
	"cherry-pick": true,
	clean: true,
	clippy: true,
	clone: true,
	commit: true,
	compose: true,
	config: true,
	create: true,
	delete: true,
	describe: true,
	diff: true,
	doc: true,
	exec: true,
	fetch: true,
	fmt: true,
	get: true,
	grep: true,
	help: true,
	info: true,
	init: true,
	install: true,
	issue: true,
	list: true,
	log: true,
	logs: true,
	"ls-files": true,
	merge: true,
	nextest: true,
	pr: true,
	ps: true,
	publish: true,
	pull: true,
	push: true,
	rebase: true,
	remote: true,
	remove: true,
	repo: true,
	reset: true,
	restore: true,
	"rev-parse": true,
	revert: true,
	run: true,
	show: true,
	stash: true,
	status: true,
	switch: true,
	sync: true,
	tag: true,
	test: true,
	tidy: true,
	uninstall: true,
	update: true,
	upgrade: true,
	version: true,
	view: true,
	worktree: true,
	x: true,
};

/** Prefix programs after which a new command name follows. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "time", "timeout", "nohup", "xargs", "do", "then", "else"]);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER = /^[\w.:/@+-]{1,128}$/;
/** Object keys shaped like schema fields; anything else (paths, labels) is data. */
const SCHEMA_KEY = /^(?:[A-Za-z_$][\w$]{0,63}|\d+)$/;

const ID_KEY = /(?:^id|Id|_id|Ids)$/;
/** Machine-minted ids: hex/uuid, or `prefix_<digits>` / `prefix_<token containing a digit>` (`toolu_01…`, `call_…|fc_…`). */
const RANDOM_ID = /^(?:[0-9a-f-]{6,}|[a-z]+_(?:\d+|(?=[\w|=-]*\d)[\w|=-]{6,}))$/i;
const SESSION_STEM = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+(?:\.jsonl)?$/;
const PATH_KEY = /(?:^path|Path|^paths|Paths|^cwd|Cwd|Dir|Directory|Directories|^file|File|Files)$/;
const SCHEME = /^[a-zA-Z][\w+.-]*:\/\//;
const DRIVE = /^[a-zA-Z]:(?=[\\/]|$)/;
const READ_SELECTOR = /(?::(?:raw|img|conflicts|\d[\d,+-]*|-\d+))+$/;
const EXTENSION = /^(.+?)((?:\.(?:test|spec|d))?\.[A-Za-z0-9]{1,8})$/;
const GLOB_CHARS = /([*?[\]{},])/;
const EXT_ONLY = /^(?:\.[A-Za-z0-9]{1,10})+$/;
/** Provider transcript addresses (`messages.3.content.0`), not filesystem paths. */
const MESSAGE_ADDRESS = /^messages(?:\.\w+)+$/;
const SHELL_FLAG = /^--?[A-Za-z][\w-]*$/;
const ENV_REF = /^\$\{?\w+\}?$/;
const ENV_ASSIGN = /^([A-Za-z_]\w*)=([\s\S]*)$/;
const MAX_PLACEHOLDER_LENGTH = 120;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltinTool(name: unknown): boolean {
	return typeof name === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

function looksLikePath(value: string): boolean {
	// Compact JSON/brace blobs (`{"a":"b/c"}`) contain slashes but are not paths.
	if (value.length === 0 || /[\s"]/.test(value) || /^[{[(]/.test(value)) return false;
	return SCHEME.test(value) || /[\\/]/.test(value) || value.startsWith("~") || DRIVE.test(value);
}

export class SessionAnonymizer {
	#tokens = new Map<string, number>();

	#index(value: string): number {
		let index = this.#tokens.get(value);
		if (index === undefined) {
			index = this.#tokens.size + 1;
			this.#tokens.set(value, index);
		}
		return index;
	}

	/** Consistent opaque stand-in for a short string literal. */
	placeholder(value: string): string {
		return value === "" ? "" : `PLACEHOLDER_${this.#index(value)}`;
	}

	/** Size-annotated marker replacing turn content. */
	redactText(value: string): string {
		if (value === "") return "";
		const lines = value.split("\n").length;
		return `[redacted #${this.#index(value)}: ${value.length} chars, ${lines} line${lines === 1 ? "" : "s"}]`;
	}

	/** Mock path preserving separators, scheme, drive, extensions, and read selectors. Accepts `;`-joined lists. */
	path(value: string): string {
		return value
			.split(";")
			.map(part => {
				// `a; b` lists: keep the separator spacing out of the mapped segment.
				const trimmed = part.trim();
				return trimmed === "" ? part : part.replace(trimmed, () => this.#singlePath(trimmed));
			})
			.join(";");
	}

	/** Mock name for a single path segment (also used for output file names). */
	segment(value: string): string {
		// Numeric segments are often tenant/ticket/account ids; only `.`/`..`/`~` pass through.
		if (value === "" || value === "." || value === ".." || value === "~") return value;
		// Session file stems (`<iso-time>_<session-id>`) only repeat kept metadata; leaving them
		// intact keeps `parentSession` pointing at the anonymized parent's real file name.
		if (KEEP_SEGMENTS[value] === true || SESSION_STEM.test(value)) return value;
		if (GLOB_CHARS.test(value)) {
			return value
				.split(GLOB_CHARS)
				.map(piece => (piece === "" || GLOB_CHARS.test(piece) || EXT_ONLY.test(piece) ? piece : this.#name(piece)))
				.join("");
		}
		return this.#name(value);
	}

	/** Anonymize one session record (header or entry). */
	entry(value: unknown): unknown {
		return isObject(value) ? this.#struct(value) : this.#opaque(value);
	}

	#name(value: string): string {
		if (value.startsWith(".") && value.length > 1) return `.${this.#name(value.slice(1))}`;
		const match = EXTENSION.exec(value);
		if (match && !/^\d+$/.test(match[1])) {
			// Index the whole name so `Probe.v2` shares its token with `PLACEHOLDER_N` and `agent://`.
			return `${KEEP_SEGMENTS[match[1]] === true ? match[1] : `seg${this.#index(value)}`}${match[2]}`;
		}
		return `seg${this.#index(value)}`;
	}

	#singlePath(raw: string): string {
		if (raw.trim() === "") return raw;
		let rest = raw;
		let prefix = "";
		let suffix = "";
		const scheme = SCHEME.exec(rest);
		if (scheme) {
			prefix = scheme[0];
			rest = rest.slice(prefix.length);
			const query = rest.indexOf("?");
			if (query >= 0) {
				suffix = `?${this.placeholder(rest.slice(query + 1))}`;
				rest = rest.slice(0, query);
			}
		} else {
			const drive = DRIVE.exec(rest);
			if (drive) {
				prefix = drive[0];
				rest = rest.slice(prefix.length);
			}
		}
		const selector = READ_SELECTOR.exec(rest);
		if (selector && selector.index > 0) {
			suffix = selector[0] + suffix;
			rest = rest.slice(0, selector.index);
		}
		const mapped = rest
			.split(/([\\/]+)/)
			.map(piece => (/^[\\/]*$/.test(piece) ? piece : this.segment(piece)))
			.join("");
		return prefix + mapped + suffix;
	}

	/** String in an unknown slot: path-shaped → mock path, short → placeholder, else redacted. */
	#literal(value: string, detectPath = true): string {
		if (detectPath && looksLikePath(value)) return this.path(value);
		if (!value.includes("\n") && value.length <= MAX_PLACEHOLDER_LENGTH) return this.placeholder(value);
		return this.redactText(value);
	}

	/** Opaque marker for a value with no export rule; keeps only its size and an equality index. */
	#opaque(value: unknown): unknown {
		if (value === undefined) return value;
		return this.redactText(typeof value === "string" ? value : JSON.stringify(value));
	}

	/**
	 * Walk an omp-defined object: ruled fields by rule, unknown fields opaque under a tokenized key.
	 * `fromTool` marks built-in tool details, whose writer cannot be verified from the transcript.
	 */
	#struct(object: JsonObject, fromTool = false): JsonObject {
		const out: JsonObject = {};
		for (const [key, value] of Object.entries(object)) {
			const rule = Object.hasOwn(FIELD_RULES, key) ? FIELD_RULES[key] : undefined;
			if (rule === undefined) out[this.placeholder(key)] = this.#opaque(value);
			else out[key] = this.#field(rule, value, object, key, fromTool);
		}
		return out;
	}

	#field(rule: Rule, value: unknown, parent: JsonObject, key: string, fromTool: boolean): unknown {
		if (rule === "opaque") return this.#opaque(value);
		if (value === null || typeof value === "number" || typeof value === "boolean") {
			return rule === "label" ? this.placeholder(String(value)) : value;
		}
		switch (rule) {
			case "args":
				return this.#toolArgs(value, parent);
			case "details":
				// Built-in tools write their own details; anything else is an extension payload.
				return parent.role === "toolResult" && isBuiltinTool(parent.toolName) && isObject(value)
					? this.#struct(value, true)
					: this.#opaque(value);
			case "data":
				// omp's execution log mirrors the tool call; every other custom entry is extension state.
				return parent.type === "custom" && parent.customType === "tool_execution_start" && isObject(value)
					? this.#struct(value, fromTool)
					: this.#opaque(value);
			case "name":
				return this.#field(
					TOOL_CALL_TYPES[String(parent.type)] === true ? "tool" : "label",
					value,
					parent,
					key,
					fromTool,
				);
		}
		if (Array.isArray(value)) return value.map(item => this.#field(rule, item, parent, key, fromTool));
		if (isObject(value)) {
			// Only structural rules descend; a scalar field holding an object is not omp's shape.
			const descends =
				rule === "struct" ||
				rule === "content" ||
				rule === "enum" ||
				rule === "id" ||
				rule === "path" ||
				rule === "tool";
			return descends ? this.#struct(value, fromTool) : this.#opaque(value);
		}
		if (typeof value !== "string") return this.#opaque(value);
		return this.#string(rule, value, key, fromTool);
	}

	#string(rule: Rule, value: string, key: string, fromTool: boolean): string {
		switch (rule) {
			case "time":
				return ISO_TIMESTAMP.test(value) ? value : this.placeholder(value);
			case "enum":
				// Tool-written values come from a closed list: a shadowing extension can reuse any field name.
				if (fromTool) return TOOL_ENUM_VALUES[key]?.has(value) ? value : this.placeholder(value);
				return value.length <= 64 && IDENTIFIER.test(value) ? value : this.placeholder(value);
			case "identity":
				if (fromTool) return /^[\w.-]+\/[\w.:@+-]+$/.test(value) ? value : this.placeholder(value);
				return IDENTIFIER.test(value) ? value : this.placeholder(value);
			case "agent":
				return getBundledAgentsMap().has(value) ? value : this.placeholder(value);
			case "spawns":
				return value === "" || value === "*"
					? value
					: value
							.split(",")
							.map(part => this.#string("agent", part.trim(), key, fromTool))
							.join(",");
			case "id":
				// Machine-minted ids omp writes stay joinable with provider logs; tool-written and named
				// ids (subagent names) are mapped like the `agent://` segment they mirror.
				return !fromTool && RANDOM_ID.test(value) ? value : this.segment(value);
			case "path":
				return MESSAGE_ADDRESS.test(value) ? value : this.path(value);
			case "cmd":
				return this.command(value);
			case "label":
			case "struct":
				return this.placeholder(value);
			case "error": {
				// Provider errors can echo request content or credentials: only a leading HTTP status survives.
				const status = /^\d{3}\b/.exec(value);
				return status
					? `${status[0]} ${this.redactText(value.slice(status[0].length).trimStart())}`
					: this.redactText(value);
			}
			case "tool":
				// Built-in and extension tool names are chosen in code; MCP names embed user-configured server names.
				return isBuiltinTool(value) || (!isMCPToolName(value) && /^[A-Za-z][\w.-]{0,63}$/.test(value))
					? value
					: this.placeholder(value);
			case "customType":
				return /^[a-z][a-z0-9_:.-]{0,63}$/.test(value) ? value : this.placeholder(value);
			default:
				// `num`, `text`, `content`: a string here is turn content (or not omp's shape).
				return this.redactText(value);
		}
	}

	/** Tool-call args: built-in tools walk their known schema; any other tool's args are opaque. */
	#toolArgs(value: unknown, parent: JsonObject): unknown {
		const toolName = typeof parent.name === "string" ? parent.name : parent.toolName;
		if (!isBuiltinTool(toolName)) return this.#opaque(value);
		if (typeof value !== "string") return this.#argValue(value, undefined);
		// Wire payloads carry arguments as JSON text; partial streams may not parse.
		try {
			return JSON.stringify(this.#argValue(JSON.parse(value), undefined));
		} catch {
			return this.redactText(value);
		}
	}

	/** One built-in tool argument: schema keys stay, values follow the argument's role. */
	#argValue(value: unknown, key: string | undefined): unknown {
		if (value === null || typeof value === "number" || typeof value === "boolean") return value;
		if (Array.isArray(value)) return value.map(item => this.#argValue(item, key));
		if (isObject(value)) {
			const out: JsonObject = {};
			for (const [childKey, child] of Object.entries(value)) {
				if (OPAQUE_ARG_KEYS[childKey] === true) out[childKey] = this.#opaque(child);
				else out[SCHEMA_KEY.test(childKey) ? childKey : this.#literal(childKey)] = this.#argValue(child, childKey);
			}
			return out;
		}
		if (typeof value !== "string") return this.#opaque(value);
		if (key === undefined) return this.#literal(value);
		// Model-written ids are tokenized (consistently), never exported raw.
		if (ID_KEY.test(key)) return this.segment(value);
		if (PATH_KEYS[key] === true || PATH_KEY.test(key)) return this.path(value);
		if (key === "command" || key === "cmd") return this.command(value);
		if (key === "agent") return this.#string("agent", value, key, true);
		if (TOOL_ENUM_VALUES[key]?.has(value)) return value;
		if (TEXT_ARG_KEYS[key] === true) return this.redactText(value);
		return this.#literal(value, PATTERN_ARG_KEYS[key] !== true);
	}

	/** Shell command with allowlisted programs, their flags/subcommands, and operators kept; literals replaced. */
	command(value: string): string {
		let out = "";
		let commandStart = true;
		let program: string | undefined;
		let argIndex = 0;
		let redirectTarget = false;
		let previousWord = "";
		let descriptorNext = false;
		for (const token of lexShellCommand(value)) {
			if (token.kind === "separator") {
				out += token.raw;
				// The shared lexer splits `2>&1` at `&`; the word after a trailing `>`/`<` is a descriptor.
				descriptorNext = token.raw === "&" && /[<>]$/.test(previousWord);
				if (descriptorNext) {
					redirectTarget = false;
				} else if (/[\n;&|()]/.test(token.raw)) {
					commandStart = true;
					program = undefined;
				}
				continue;
			}
			const word = token.raw;
			previousWord = word;
			if (descriptorNext && /^\d+$/.test(word)) {
				descriptorNext = false;
				out += word;
				continue;
			}
			descriptorNext = false;
			// The lexer keeps redirections inside words (`>out.txt`, `2>`, `<<EOF`); their operand is a path.
			const redirect = /^\d*(?:>>?|<<?-?)/.exec(word);
			if (redirect) {
				const target = word.slice(redirect[0].length);
				out += redirect[0] + (target === "" ? "" : this.#shellValue(target, true));
				redirectTarget = target === "";
				continue;
			}
			if (redirectTarget) {
				redirectTarget = false;
				out += this.#shellValue(word, true);
				continue;
			}
			if (commandStart) {
				const assign = ENV_ASSIGN.exec(word);
				if (assign) {
					out += `${assign[1]}=${this.#shellValue(assign[2], false)}`;
					continue;
				}
				commandStart = COMMAND_PREFIXES.has(word);
				program = SHELL_COMMANDS.has(word) ? word : undefined;
				out += program ?? this.#shellValue(word, false);
				argIndex = 0;
				continue;
			}
			out += this.#shellArg(word, program, argIndex);
			// Positional index only: `git --no-pager log` still sees `log` as the subcommand.
			if (!word.startsWith("-")) argIndex++;
		}
		return out;
	}

	#shellArg(word: string, program: string | undefined, argIndex: number): string {
		// `-3` (head/tail count style) is a flag; bare numeric operands may be ids, PINs, or amounts.
		if (/^-\d+$/.test(word) || ENV_REF.test(word)) return word;
		// Flag names are vocabulary only for allowlisted programs; an unknown script's flags may name things.
		if (program === undefined) return this.#shellValue(word, false);
		if (SHELL_FLAG.test(word)) {
			// `-ehunter2` attaches a value to a short option; only long flags and bare `-x` are names.
			return word.startsWith("--") || word.length <= 2
				? word
				: word.slice(0, 2) + this.#shellValue(word.slice(2), false);
		}
		const flagValue = /^(--?[A-Za-z][\w-]*=)([\s\S]*)$/.exec(word);
		if (flagValue) return flagValue[1] + this.#shellValue(flagValue[2], false);
		if (argIndex === 0 && SUBCOMMANDS[word] === true) return word;
		return this.#shellValue(word, false);
	}

	/** Transform one shell word, preserving surrounding quotes. */
	#shellValue(word: string, isPath: boolean): string {
		const quote = word[0];
		if ((quote === '"' || quote === "'") && word.length >= 2 && word.endsWith(quote)) {
			return quote + this.#shellValue(word.slice(1, -1), isPath) + quote;
		}
		if (word === "" || ENV_REF.test(word)) return word;
		if (isPath || looksLikePath(word)) return this.path(word);
		return this.#literal(word);
	}
}

/** A session transcript to anonymize: its header, entries, and file (for subagent discovery). */
export interface AnonymizeSessionInput {
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	sessionFile?: string;
	/** Malformed records the caller skipped while loading the main transcript. */
	malformedRecords?: number;
}

/** Anonymized JSONL bodies for a session and its persisted subagents. */
export interface AnonymizedTranscripts {
	/** `[member path, JSONL body]`: `session.jsonl`, then `subagents/<mapped agent path>.jsonl`. */
	files: Array<readonly [string, string]>;
	subagentCount: number;
	/** Why subagent discovery failed; the main transcript is anonymized regardless. */
	subagentError?: string;
	/** `[member path, count]` for transcripts whose malformed JSONL records were skipped. */
	malformed: Array<readonly [string, number]>;
}

/**
 * Anonymize a session and every subagent transcript stored next to it with one
 * shared token table, so names, paths, and literals correlate across files.
 */
export async function anonymizeSessionTranscripts(session: AnonymizeSessionInput): Promise<AnonymizedTranscripts> {
	const anonymizer = new SessionAnonymizer();
	const toJsonl = (header: SessionHeader | null, entries: readonly SessionEntry[]): string => {
		const records: unknown[] = header ? [header, ...entries] : [...entries];
		return `${records.map(record => JSON.stringify(anonymizer.entry(record))).join("\n")}\n`;
	};
	const files: Array<readonly [string, string]> = [["session.jsonl", toJsonl(session.header, session.entries)]];
	const malformed: Array<readonly [string, number]> = [];
	if (session.malformedRecords) malformed.push(["session.jsonl", session.malformedRecords]);
	let subSessions: Record<string, SubSession> = {};
	let subagentError: string | undefined;
	try {
		if (session.sessionFile) subSessions = await collectSubSessions(session.sessionFile);
	} catch (error) {
		subagentError = error instanceof Error ? error.message : String(error);
		logger.warn("Failed to collect subagent transcripts for anonymization", { error: subagentError });
	}
	for (const [key, sub] of Object.entries(subSessions)) {
		// Agent ids map through the same table as `agent://<id>` path segments.
		const mappedKey = key
			.split("/")
			.map(part => anonymizer.segment(part))
			.join("/");
		const member = `subagents/${mappedKey}.jsonl`;
		files.push([member, toJsonl(sub.header, sub.entries)]);
		if (sub.malformedRecords > 0) malformed.push([member, sub.malformedRecords]);
	}
	return { files, subagentCount: files.length - 1, subagentError, malformed };
}
