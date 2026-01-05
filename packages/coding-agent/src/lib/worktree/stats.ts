import { git } from "./git";

export interface WorktreeStats {
	additions: number;
	deletions: number;
	untracked: number;
	modified: number;
	staged: number;
}

/**
 * Get diff statistics for a worktree.
 */
export async function getStats(worktreePath: string): Promise<WorktreeStats> {
	const diffResult = await git(["diff", "HEAD", "--shortstat"], worktreePath);

	let additions = 0;
	let deletions = 0;

	const statsLine = diffResult.stdout.trim();
	if (statsLine) {
		const insertMatch = statsLine.match(/(\d+) insertion/);
		const deleteMatch = statsLine.match(/(\d+) deletion/);
		if (insertMatch) additions = parseInt(insertMatch[1], 10);
		if (deleteMatch) deletions = parseInt(deleteMatch[1], 10);
	}

	const untrackedResult = await git(["ls-files", "--others", "--exclude-standard"], worktreePath);
	const untracked = untrackedResult.stdout.trim() ? untrackedResult.stdout.trim().split("\n").length : 0;

	const statusResult = await git(["status", "--porcelain"], worktreePath);
	let modified = 0;
	let staged = 0;

	for (const line of statusResult.stdout.split("\n")) {
		if (!line) continue;
		const index = line[0];
		const worktree = line[1];
		if (index !== " " && index !== "?") staged += 1;
		if (worktree !== " " && worktree !== "?") modified += 1;
	}

	return { additions, deletions, untracked, modified, staged };
}

/**
 * Format stats for display.
 * Returns "clean" or "+N -M ?U" format.
 */
export function formatStats(stats: WorktreeStats): string {
	if (
		stats.additions === 0 &&
		stats.deletions === 0 &&
		stats.untracked === 0 &&
		stats.modified === 0 &&
		stats.staged === 0
	) {
		return "clean";
	}

	const parts: string[] = [];
	if (stats.additions > 0) parts.push(`+${stats.additions}`);
	if (stats.deletions > 0) parts.push(`-${stats.deletions}`);
	if (stats.untracked > 0) parts.push(`?${stats.untracked}`);

	return parts.join(" ") || "clean";
}
