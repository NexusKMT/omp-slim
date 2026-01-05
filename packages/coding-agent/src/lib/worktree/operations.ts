import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { WORKTREE_BASE } from "./constants";
import { WorktreeError, WorktreeErrorCode } from "./errors";
import { getRepoName, getRepoRoot, git } from "./git";

export interface Worktree {
	path: string;
	branch: string | null;
	head: string;
	isMain: boolean;
	isDetached: boolean;
}

type WorktreePartial = Partial<Worktree> & { isDetached?: boolean };

function finalizeWorktree(entry: WorktreePartial, repoRoot: string): Worktree {
	const wtPath = entry.path?.trim();
	if (!wtPath) {
		throw new Error("Invalid worktree entry");
	}
	const branch = entry.isDetached ? null : (entry.branch ?? null);
	const isDetached = entry.isDetached ?? branch === null;
	return {
		path: wtPath,
		branch,
		head: entry.head ?? "",
		isMain: path.resolve(wtPath) === path.resolve(repoRoot),
		isDetached,
	};
}

function parseWorktreeList(output: string, repoRoot: string): Worktree[] {
	const worktrees: Worktree[] = [];
	let current: WorktreePartial = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(finalizeWorktree(current, repoRoot));
			}
			current = { path: line.slice(9) };
			continue;
		}

		if (line.startsWith("HEAD ")) {
			current.head = line.slice(5);
			continue;
		}

		if (line.startsWith("branch ")) {
			const raw = line.slice(7);
			current.branch = raw.startsWith("refs/heads/") ? raw.slice("refs/heads/".length) : raw;
			continue;
		}

		if (line === "detached") {
			current.isDetached = true;
		}
	}

	if (current.path) {
		worktrees.push(finalizeWorktree(current, repoRoot));
	}

	return worktrees;
}

/**
 * Create a new worktree.
 */
export async function create(branch: string, options?: { base?: string; path?: string }): Promise<Worktree> {
	const repoRoot = await getRepoRoot();
	const repoName = await getRepoName();
	const targetPath = options?.path ?? path.join(WORKTREE_BASE, repoName, branch);
	const resolvedTarget = path.resolve(targetPath);

	const existing = await list();
	const conflict = existing.find((wt) => wt.branch === branch || path.resolve(wt.path) === resolvedTarget);
	if (conflict) {
		throw new WorktreeError(`Worktree already exists: ${conflict.path}`, WorktreeErrorCode.WORKTREE_EXISTS);
	}

	await mkdir(path.dirname(resolvedTarget), { recursive: true });

	const branchExists = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot)).code === 0;

	const args = branchExists
		? ["worktree", "add", resolvedTarget, branch]
		: ["worktree", "add", "-b", branch, resolvedTarget, options?.base ?? "HEAD"];

	const result = await git(args, repoRoot);
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		if (stderr.includes("already exists") || stderr.includes("already checked out")) {
			throw new WorktreeError(stderr || "Worktree already exists", WorktreeErrorCode.WORKTREE_EXISTS);
		}
		throw new Error(stderr || "Failed to create worktree");
	}

	const updated = await list();
	const created = updated.find((wt) => path.resolve(wt.path) === resolvedTarget);
	if (!created) {
		throw new Error("Worktree created but not found in list");
	}

	return created;
}

/**
 * List all worktrees for current repository.
 */
export async function list(): Promise<Worktree[]> {
	const repoRoot = await getRepoRoot();
	const result = await git(["worktree", "list", "--porcelain"], repoRoot);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Failed to list worktrees");
	}
	return parseWorktreeList(result.stdout, repoRoot);
}

/**
 * Find a worktree by pattern.
 */
export async function find(pattern: string): Promise<Worktree> {
	const worktrees = await list();

	const exactBranch = worktrees.filter((wt) => wt.branch === pattern);
	if (exactBranch.length === 1) return exactBranch[0];
	if (exactBranch.length > 1) {
		throw new WorktreeError(`Ambiguous worktree: ${pattern}`, WorktreeErrorCode.WORKTREE_NOT_FOUND);
	}

	const exactDir = worktrees.filter((wt) => path.basename(wt.path) === pattern);
	if (exactDir.length === 1) return exactDir[0];
	if (exactDir.length > 1) {
		throw new WorktreeError(`Ambiguous worktree: ${pattern}`, WorktreeErrorCode.WORKTREE_NOT_FOUND);
	}

	const partialBranch = worktrees.filter((wt) => wt.branch?.includes(pattern));
	if (partialBranch.length === 1) return partialBranch[0];
	if (partialBranch.length > 1) {
		throw new WorktreeError(`Ambiguous worktree: ${pattern}`, WorktreeErrorCode.WORKTREE_NOT_FOUND);
	}

	const partialPath = worktrees.filter((wt) => wt.path.includes(pattern));
	if (partialPath.length === 1) return partialPath[0];
	if (partialPath.length > 1) {
		throw new WorktreeError(`Ambiguous worktree: ${pattern}`, WorktreeErrorCode.WORKTREE_NOT_FOUND);
	}

	throw new WorktreeError(`Worktree not found: ${pattern}`, WorktreeErrorCode.WORKTREE_NOT_FOUND);
}

/**
 * Remove a worktree.
 */
export async function remove(nameOrPath: string, options?: { force?: boolean }): Promise<void> {
	const wt = await find(nameOrPath);
	if (wt.isMain) {
		throw new WorktreeError("Cannot remove main worktree", WorktreeErrorCode.CANNOT_MODIFY_MAIN);
	}

	const repoRoot = await getRepoRoot();
	const args = ["worktree", "remove", wt.path];
	if (options?.force) args.push("--force");

	const result = await git(args, repoRoot);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Failed to remove worktree");
	}
}

/**
 * Remove worktrees for branches that no longer exist.
 */
export async function prune(): Promise<number> {
	const repoRoot = await getRepoRoot();
	const worktrees = await list();
	let removed = 0;

	for (const wt of worktrees) {
		if (wt.isMain || !wt.branch) continue;
		const existsResult = await git(["rev-parse", "--verify", `refs/heads/${wt.branch}`], repoRoot);
		if (existsResult.code === 0) continue;

		const result = await git(["worktree", "remove", wt.path], repoRoot);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `Failed to remove worktree: ${wt.path}`);
		}
		removed += 1;
	}

	return removed;
}

/**
 * Get the worktree containing the given path.
 * Returns null if path is not in any worktree.
 */
export async function which(targetPath?: string): Promise<Worktree | null> {
	const worktrees = await list();
	const resolved = path.resolve(targetPath ?? process.cwd());

	let best: Worktree | null = null;
	for (const wt of worktrees) {
		const wtPath = path.resolve(wt.path);
		if (resolved === wtPath || resolved.startsWith(wtPath + path.sep)) {
			if (!best || wtPath.length > best.path.length) {
				best = wt;
			}
		}
	}

	return best;
}
