/**
 * Protocol handler for `cfg://` URLs: the agent's view of omp settings.
 *
 * Read forms (`/` and `.` both separate segments):
 * - `cfg://`                  every setting as a YAML-ish tree
 * - `cfg://<namespace>`       one namespace's subtree, e.g. `cfg://advisor`
 * - `cfg://<setting>`         one setting: value, type, default, source, description
 *
 * Write forms (content is the new value). Only a top-level session with a UI may
 * write, and every write requires user approval through the host registered with
 * {@link setCfgApprovalHost}. Subagents and headless sessions (print, RPC, ACP,
 * background forks) are refused so they never block on a prompt the user did
 * not start:
 * - `cfg://<setting>`         session-only runtime override
 * - `cfg://<setting>/save`    persisted to the global config.yml
 *
 * Credential values are always redacted.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { fuzzyFilter } from "@oh-my-pi/pi-tui/fuzzy";
import { type CfgWriteDetails, type CfgWriteOutcome } from "@oh-my-pi/pi-tui/tools/cfg-render";
import { CFG_SAVE_SEGMENT, CFG_URL_PREFIX, parseCfgUrl } from "@oh-my-pi/pi-tui/tools/cfg-url";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	isCredential,
	parseSettingValue,
	type SettingPath,
	type SettingProvenance,
	type Settings,
	SETTINGS_SCHEMA,
} from "../config/settings";
import cfgWriteResultTemplate from "../prompts/tools/cfg-write-result.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

let sortedPaths: SettingPath[] | undefined;

/**
 * Every setting path, ordered segment by segment so each namespace's members stay
 * contiguous. Computed on first use: the settings module is still initializing
 * when the router loads this handler.
 */
function allPaths(): SettingPath[] {
	sortedPaths ??= (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).sort((a, b) => {
		const left = a.split(".");
		const right = b.split(".");
		for (let i = 0; i < Math.min(left.length, right.length); i++) {
			const order = left[i]!.localeCompare(right[i]!, "en", { sensitivity: "base" });
			if (order !== 0) return order;
		}
		return left.length - right.length;
	});
	return sortedPaths;
}
const REDACTED = "<redacted>";
/** Tree listings keep only the description's first sentence, capped here; single-setting reads show it whole. */
const TREE_COMMENT_MAX_CHARS = 120;

const PROVENANCE_LABELS: Record<SettingProvenance, string> = {
	runtime: "session override",
	overlay: "--config overlay",
	project: "project config",
	global: "global config",
	default: "default",
};

/** A settings change awaiting the user's decision. Values are display-formatted, credentials redacted. */
export interface CfgChangeRequest {
	path: SettingPath;
	previous: string;
	value: string;
	/** Persist to config.yml instead of scoping the change to the session. */
	save: boolean;
}

/** An approved change that took effect on one {@link Settings} instance. */
export interface CfgAppliedChange {
	path: SettingPath;
	/** Effective value on {@link settings} after the change. */
	value: unknown;
	settings: Settings;
	/** Whether the change was persisted to config.yml. */
	save: boolean;
}

/** Host UI that approves `cfg://` writes, plus the disk-backed settings `/save` persists to. */
export interface CfgApprovalHost {
	/** Resolves `true` only when the user explicitly approves the change. */
	approve(request: CfgChangeRequest): Promise<boolean>;
	/**
	 * Called once per settings instance whose value changed, so the host can apply
	 * live side effects (e.g. start the advisor runtime); a settings value alone
	 * does not restart components that read it at startup.
	 */
	applied(change: CfgAppliedChange): void;
	persistentSettings: Settings;
}

let approvalHost: CfgApprovalHost | null = null;
/** Tail of the approval chain; concurrent writes prompt one at a time. */
let approvalQueue: Promise<unknown> = Promise.resolve();

/**
 * Register the process-global approval host for `cfg://` writes. `/save`
 * persists through its disk-backed settings even when the calling session's
 * `Settings` is a separate instance. Passing `null` clears it; without a host
 * every write is refused, since nobody can approve it.
 */
export function setCfgApprovalHost(host: CfgApprovalHost | null): void {
	approvalHost = host;
}

function formatValue(path: SettingPath, value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (isCredential(path) && value !== "") return REDACTED;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return JSON.stringify(value);
}

/**
 * Canonicalize URL segments against the schema, case-insensitively.
 * `leaf` is set when the path names a setting; `members` lists every setting beneath it.
 *
 * @throws Error when the path names neither a setting nor a namespace.
 */
function resolveSegments(segments: readonly string[]): { path: string; leaf?: SettingPath; members: SettingPath[] } {
	if (segments.length === 0) return { path: "", members: allPaths() };
	const lower = segments.join(".").toLowerCase();
	const leaf = allPaths().find(candidate => candidate.toLowerCase() === lower);
	const members = allPaths().filter(candidate => candidate.toLowerCase().startsWith(`${lower}.`));
	const path = leaf ?? members[0]?.slice(0, lower.length);
	if (path === undefined) {
		const similar = fuzzyFilter(allPaths(), segments.join("."), candidate => candidate).slice(0, 8);
		const hint = similar.length > 0 ? `\nSimilar: ${similar.join(", ")}` : "";
		throw new Error(`Unknown setting: ${segments.join(".")}${hint}\nRead ${CFG_URL_PREFIX} for the full tree.`);
	}
	return { path, leaf, members };
}

function treeComment(path: SettingPath, value: unknown): string {
	const parts: string[] = [];
	const choices = getEnumValues(path);
	if (choices) parts.push(choices.join("|"));
	const fallback = getDefault(path);
	if (!Bun.deepEquals(value, fallback)) parts.push(`default ${formatValue(path, fallback)}`);
	const description = getUi(path)?.description;
	if (description) {
		const sentence = description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description;
		parts.push(
			sentence.length > TREE_COMMENT_MAX_CHARS ? `${sentence.slice(0, TREE_COMMENT_MAX_CHARS - 1)}…` : sentence,
		);
	}
	return parts.length > 0 ? `  # ${parts.join(" · ")}` : "";
}

/** YAML-ish tree of `members`, rooted below `prefix`. Returns the rendered text and the count of non-default values. */
function renderTree(
	settings: Settings,
	members: readonly SettingPath[],
	prefix: string,
): { text: string; modified: number } {
	const lines: string[] = [];
	let modified = 0;
	const opened: string[] = [];
	const strip = prefix ? prefix.length + 1 : 0;
	for (const path of members) {
		const segments = path.slice(strip).split(".");
		let shared = 0;
		while (shared < opened.length && shared < segments.length - 1 && opened[shared] === segments[shared]) shared++;
		opened.length = shared;
		for (let depth = shared; depth < segments.length - 1; depth++) {
			lines.push(`${"  ".repeat(depth)}${segments[depth]}:`);
			opened.push(segments[depth]!);
		}
		const value = settings.get(path);
		if (!Bun.deepEquals(value, getDefault(path))) modified++;
		const indent = "  ".repeat(segments.length - 1);
		lines.push(`${indent}${segments.at(-1)}: ${formatValue(path, value)}${treeComment(path, value)}`);
	}
	return { text: lines.join("\n"), modified };
}

function renderLeaf(settings: Settings, path: SettingPath): string {
	const value = settings.get(path);
	const lines = [
		`${path}: ${formatValue(path, value)}`,
		`type: ${getType(path)}`,
		`default: ${formatValue(path, getDefault(path))}`,
		`source: ${PROVENANCE_LABELS[settings.getProvenance(path)]}`,
	];
	const choices = getEnumValues(path);
	if (choices) lines.push(`values: [${choices.join(", ")}]`);
	const description = getUi(path)?.description;
	if (description) lines.push(`description: ${description}`);
	return lines.join("\n");
}

function callerSession(context: ResolveContext | WriteContext | undefined): ToolSession {
	const session = context?.session;
	if (!session?.settings) throw new Error(`${CFG_URL_PREFIX} requires a calling session.`);
	return session;
}

/**
 * Settings of a caller allowed to write. Refuses sessions that must not raise
 * approval prompts: subagents (the user is not driving them) and sessions without
 * a UI (print, RPC, ACP, `/tan` forks, programmatic agents).
 */
function writerSettings(context: WriteContext | undefined): Settings {
	const session = callerSession(context);
	if ((session.taskDepth ?? 0) > 0) {
		throw new Error(
			`Subagents cannot change settings. Report the setting you need changed to the parent agent instead of writing ${CFG_URL_PREFIX}.`,
		);
	}
	if (!session.hasUI) {
		throw new Error(
			`Changing settings requires user approval, but this session has no interactive UI. Ask the user to change the setting themselves.`,
		);
	}
	return session.settings;
}

export class CfgProtocolHandler implements ProtocolHandler {
	readonly scheme = "cfg";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const { settings } = callerSession(context);
		const target = parseCfgUrl(url.rawHref ?? url.href);
		const { path, leaf, members } = resolveSegments(target?.segments ?? []);
		const sections: string[] = [];
		let modified = 0;
		if (leaf) {
			sections.push(renderLeaf(settings, leaf));
			if (!Bun.deepEquals(settings.get(leaf), getDefault(leaf))) modified++;
		}
		if (members.length > 0) {
			const tree = renderTree(settings, members, path);
			sections.push(tree.text);
			modified += tree.modified;
		}
		const content = sections.join("\n\n");
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			details: { cfg: { path, count: members.length + (leaf ? 1 : 0), modified } },
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const settings = writerSettings(context);
		const target = parseCfgUrl(url.rawHref ?? url.href);
		const { path, leaf } = resolveSegments(target?.segments ?? []);
		if (!leaf) {
			const example = `${CFG_URL_PREFIX}${path ? `${path.replaceAll(".", "/")}/` : ""}<key>`;
			throw new Error(`${path || CFG_URL_PREFIX} is a namespace; write a single setting, e.g. ${example}.`);
		}
		const save = target?.save ?? false;
		const value = parseSettingValue(leaf, content);
		const previous = settings.get(leaf);
		const request: CfgChangeRequest = {
			path: leaf,
			previous: formatValue(leaf, previous),
			value: formatValue(leaf, value),
			save,
		};
		const settingUrl = `${CFG_URL_PREFIX}${leaf.replaceAll(".", "/")}`;
		const finish = (outcome: CfgWriteOutcome, effective?: string): InternalWriteResult => {
			const details: CfgWriteDetails = { ...request, outcome, ...(effective !== undefined ? { effective } : {}) };
			const text = prompt
				.render(cfgWriteResultTemplate, {
					...request,
					url: settingUrl,
					saveUrl: `${settingUrl}/${CFG_SAVE_SEGMENT}`,
					declined: outcome === "declined",
					unchanged: outcome === "unchanged",
					saved: outcome === "applied" && save,
					applied: outcome === "applied" && !save,
					effective,
					provenance: PROVENANCE_LABELS[settings.getProvenance(leaf)],
				})
				.trim();
			return { text, details: { cfg: details } };
		};

		if (!save && Bun.deepEquals(previous, value)) return finish("unchanged");
		const host = approvalHost;
		if (!host) {
			throw new Error(
				`Changing settings requires user approval, but no interactive UI is attached. Ask the user to change \`${leaf}\` themselves.`,
			);
		}
		const decision = approvalQueue.then(() => host.approve(request));
		approvalQueue = decision.catch(() => undefined);
		if (!(await decision)) return finish("declined");

		if (!save) {
			settings.override(leaf, value);
			host.applied({ path: leaf, value: settings.get(leaf), settings, save });
			return finish("applied");
		}
		const persistent = host.persistentSettings;
		persistent.set(leaf, value);
		await persistent.flush();
		// A session sharing the persistent instance drops its override so the saved value
		// takes effect; a separate instance never reloads from disk, so mirror it.
		if (settings === persistent) {
			settings.clearOverride(leaf);
		} else {
			settings.override(leaf, value);
			host.applied({ path: leaf, value: persistent.get(leaf), settings: persistent, save });
		}
		const effective = settings.get(leaf);
		host.applied({ path: leaf, value: effective, settings, save });
		return finish("applied", Bun.deepEquals(effective, value) ? undefined : formatValue(leaf, effective));
	}

	async complete(): Promise<UrlCompletion[]> {
		return allPaths().map(path => {
			const description = getUi(path)?.description;
			return { value: path.replaceAll(".", "/"), ...(description ? { description } : {}) };
		});
	}
}
