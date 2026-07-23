import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import type { GitStatusSummary } from "../../../utils/git";

/**
 * Throttle for the working-copy jj query. The statusline calls into jj only
 * while the `git` segment is shown in a colocated jj repo (where git HEAD is
 * parked detached), so a moderate TTL keeps the subprocess rate negligible
 * while a HEAD change still forces an immediate refresh (see
 * `#invalidateGitCaches`).
 */
export const JJ_BRANCH_TTL_MS = 5000;

/**
 * The statusline labels the working copy by its bookmark, not its commit — in
 * jj a bookmark doesn't follow `@`, so `@` itself is usually unbookmarked and
 * the meaningful name lives on the nearest ancestor. The revset selects `@`
 * plus that nearest ancestor bookmark; the template emits one
 * `change_id|local_bookmarks` line per commit (newest — `@` — first).
 */
const JJ_BRANCH_REVSET = "@ | heads(::@ & bookmarks())";
const JJ_BRANCH_TEMPLATE = 'change_id.shortest(8) ++ "|" ++ local_bookmarks ++ "\\n"';

/**
 * Walk up from `cwd` to the colocated jj workspace root — the nearest ancestor
 * directory holding a `.jj` entry. Returns `null` when none exists. Sync on
 * purpose: it feeds the synchronous statusline render path and is cached per
 * cwd by the caller, so it runs at most once per directory.
 */
export function findJjRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".jj"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Parse the `change_id|local_bookmarks` lines (newest first, so `@` leads) into
 * the display label: the nearest bookmark wins — `@`'s own when it has one, else
 * the nearest ancestor's — falling back to `@`'s change-id when no bookmark
 * exists in the ancestry. Returns `null` for empty output.
 */
export function formatJjBranch(raw: string): string | null {
	let changeId: string | null = null;
	for (const line of raw.split("\n")) {
		const sep = line.indexOf("|");
		const change = (sep === -1 ? line : line.slice(0, sep)).trim();
		const bookmarks = sep === -1 ? "" : line.slice(sep + 1).trim();
		if (changeId === null && change) changeId = change;
		if (bookmarks) return bookmarks.replace(/\s+/g, " ");
	}
	return changeId;
}

/** Runs the jj query in `root`; injectable so the parse boundary is testable without jj. */
export type JjRunner = (root: string) => Promise<{ exitCode: number; stdout: string }>;

const defaultRunner: JjRunner = async root => {
	// `--ignore-working-copy` keeps the query read-only (never snapshots the
	// working copy), so it is safe to run on every refresh.
	const res =
		await $`jj log --no-graph --ignore-working-copy --color never -r ${JJ_BRANCH_REVSET} -T ${JJ_BRANCH_TEMPLATE}`
			.cwd(root)
			.quiet()
			.nothrow();
	return { exitCode: res.exitCode, stdout: res.text() };
};

/**
 * Query the jj working-copy bookmark label for `root`. Returns
 * `null` on any failure — non-zero exit (not a jj repo) or a missing `jj`
 * binary — so the caller cleanly falls back to git's detached-HEAD label.
 */
export async function queryJjBranch(root: string, runner: JjRunner = defaultRunner): Promise<string | null> {
	try {
		const res = await runner(root);
		if (res.exitCode !== 0) return null;
		return formatJjBranch(res.stdout);
	} catch {
		return null;
	}
}

/**
 * jj working-copy status: `jj diff -r @ --summary` emits one `<type> <path>`
 * line per changed file (M/A/D/R/C). Mapped to the git status shape for the
 * shared renderer — jj has no index, so `staged` is always 0; added files (new
 * in `@`) read as untracked, every other change as unstaged.
 */
export function parseJjStatus(raw: string): GitStatusSummary {
	let unstaged = 0;
	let untracked = 0;
	for (const line of raw.split("\n")) {
		const type = line.trim()[0];
		if (!type) continue;
		if (type === "A") untracked++;
		else unstaged++;
	}
	return { staged: 0, unstaged, untracked };
}

const defaultStatusRunner: JjRunner = async root => {
	const res = await $`jj diff -r @ --summary --ignore-working-copy --color never`.cwd(root).quiet().nothrow();
	return { exitCode: res.exitCode, stdout: res.text() };
};

/**
 * Query the jj working-copy status counts for `root` — the changes in `@`
 * relative to its parent. Returns `null` on any failure (not a jj repo, no `jj`
 * binary) so the caller falls back to git status; a clean `@` yields all zeros.
 */
export async function queryJjStatus(
	root: string,
	runner: JjRunner = defaultStatusRunner,
): Promise<GitStatusSummary | null> {
	try {
		const res = await runner(root);
		if (res.exitCode !== 0) return null;
		return parseJjStatus(res.stdout);
	} catch {
		return null;
	}
}
