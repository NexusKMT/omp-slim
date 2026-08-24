/**
 * Git data model for the `omp git` fullscreen TUI.
 *
 * Owns porcelain status parsing into staged/unstaged file lists, HEAD commit
 * metadata for the clean-tree view, per-file old/new content resolution for
 * the split diff pane, and the staging/commit actions the sidebar triggers.
 */
import * as path from "node:path";
import { DiffSide, DiffStream, type DiffStreamProgress, type DiffStreamResult } from "@oh-my-pi/pi-natives";
import { parseNumstat } from "../../commit/git/diff";
import type { NumstatEntry } from "../../commit/types";
import * as git from "../../utils/git";

/** SHA of git's canonical empty tree: diff base for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Files larger than this render as a placeholder instead of a diff. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Context lines retained around each exact streamed hunk. */
export const DIFF_CONTEXT_LINES = 3;

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
export type ChangeArea = "unstaged" | "staged" | "commit";

/** One changed path shown in the sidebar file lists. */
export interface ChangedFile {
	readonly path: string;
	/** Pre-rename path for renames/copies. */
	readonly origPath?: string;
	readonly kind: ChangeKind;
	readonly area: ChangeArea;
	readonly additions?: number;
	readonly deletions?: number;
}

/** HEAD commit metadata for the clean-tree sidebar view. */
export interface HeadCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly subject: string;
	readonly body: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly parents: readonly string[];
	/** Changed paths once their numstats have loaded. */
	readonly files: readonly ChangedFile[];
	/** Whether {@link files} contains the complete commit file list. */
	readonly filesLoaded: boolean;
}

/** Old/new sides of a file for the split diff pane. */
export interface FileContents {
	readonly oldText: string;
	readonly newText: string;
	readonly binary: boolean;
	readonly tooLarge: boolean;
	/** Exact native runs/hunks, or null when the file is binary/oversized. */
	readonly streamResult: DiffStreamResult | null;
}

/** Newly completed lines and state emitted while a file pair streams. */
export interface FileStreamUpdate {
	readonly oldLineOffset: number;
	readonly oldLines: readonly string[];
	readonly newLineOffset: number;
	readonly newLines: readonly string[];
	readonly progress: DiffStreamProgress;
}

function kindFromLetter(letter: string): ChangeKind {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		case "U":
			return "conflicted";
		default:
			return "modified";
	}
}

const CONFLICT_STATES: Record<string, true> = { DD: true, AU: true, UD: true, UA: true, DU: true, AA: true, UU: true };

/**
 * Repository state backing the git TUI. `refresh()` re-reads everything and
 * returns whether the observable state changed since the previous refresh.
 */
export class GitModel {
	readonly cwd: string;
	/** Resolved SHA when the TUI is pinned to one commit (`omp git <rev>`). */
	readonly pinnedSha: string | null;
	branch: string | null = null;
	unstaged: ChangedFile[] = [];
	staged: ChangedFile[] = [];
	headCommit: HeadCommit | null = null;
	#fingerprint = "";
	#statusStatsLoad: Promise<boolean> | null = null;
	#headFilesLoad: Promise<boolean> | null = null;

	constructor(cwd: string, options: { pinnedSha?: string } = {}) {
		this.cwd = cwd;
		this.pinnedSha = options.pinnedSha ?? null;
	}

	/** True when the working tree and index carry no changes. */
	get clean(): boolean {
		return this.unstaged.length === 0 && this.staged.length === 0;
	}

	/** Re-read fast repository state; expensive numstats load separately. */
	async refresh(): Promise<boolean> {
		if (this.pinnedSha) {
			if (this.#fingerprint === this.pinnedSha) return false;
			this.#fingerprint = this.pinnedSha;
			this.#headFilesLoad = null;
			this.headCommit = await this.#loadHeadMetadata(this.pinnedSha);
			return true;
		}
		const [statusText, branchName, headSha] = await Promise.all([
			git.status(this.cwd, { porcelainV1: true, z: true, untrackedFiles: "all" }).catch(() => null),
			git.branch.current(this.cwd).catch(() => null),
			git.head.sha(this.cwd).catch(() => null),
		]);
		if (statusText === null) throw new Error("Not a git repository");
		const fingerprint = `${headSha ?? ""}\u0000${statusText}`;
		if (fingerprint === this.#fingerprint) {
			this.branch = branchName;
			return false;
		}
		this.#fingerprint = fingerprint;
		this.#statusStatsLoad = null;
		this.branch = branchName;
		this.#setChanges(statusText);
		if (headSha !== this.headCommit?.sha) {
			this.#headFilesLoad = null;
			this.headCommit = headSha ? await this.#loadHeadMetadata(headSha) : null;
		}
		return true;
	}

	/** Populate changed-line counts after the file list is already interactive. */
	async loadChangeStats(): Promise<boolean> {
		if (this.clean) return false;
		if (this.#statusStatsLoad) return await this.#statusStatsLoad;
		const fingerprint = this.#fingerprint;
		const load = (async (): Promise<boolean> => {
			const [unstagedStat, stagedStat] = await Promise.all([
				git.diff(this.cwd, { numstat: true, allowFailure: true }).then(parseNumstat),
				git.diff(this.cwd, { numstat: true, cached: true, allowFailure: true }).then(parseNumstat),
			]);
			if (fingerprint !== this.#fingerprint) return false;
			const unstagedCounts = new Map(unstagedStat.map(entry => [entry.path, entry]));
			const stagedCounts = new Map(stagedStat.map(entry => [entry.path, entry]));
			this.unstaged = this.#withCounts(this.unstaged, unstagedCounts);
			this.staged = this.#withCounts(this.staged, stagedCounts);
			return true;
		})();
		this.#statusStatsLoad = load;
		try {
			return await load;
		} finally {
			if (this.#statusStatsLoad === load) this.#statusStatsLoad = null;
		}
	}

	/** Load changed-file details for the clean commit view without delaying initial paint. */
	async loadHeadFiles(): Promise<boolean> {
		const head = this.headCommit;
		if (!head || !this.clean || head.filesLoaded) return false;
		if (this.#headFilesLoad) return await this.#headFilesLoad;
		const load = (async (): Promise<boolean> => {
			const base = head.parents[0] ?? EMPTY_TREE;
			const numstat = parseNumstat(
				await git.diff(this.cwd, { numstat: true, base, head: head.sha, allowFailure: true }),
			);
			if (this.headCommit?.sha !== head.sha) return false;
			this.headCommit = {
				...head,
				files: numstat.map(entry => ({
					path: entry.path,
					kind: entry.additions > 0 && entry.deletions === 0 ? "added" : "modified",
					area: "commit" as const,
					additions: entry.additions,
					deletions: entry.deletions,
				})),
				filesLoaded: true,
			};
			return true;
		})();
		this.#headFilesLoad = load;
		try {
			return await load;
		} finally {
			if (this.#headFilesLoad === load) this.#headFilesLoad = null;
		}
	}

	#setChanges(statusText: string): void {
		const unstaged: ChangedFile[] = [];
		const staged: ChangedFile[] = [];
		const tokens = statusText.split("\0");
		for (let i = 0; i < tokens.length; i++) {
			const record = tokens[i];
			if (record.length < 4) continue;
			const x = record[0];
			const y = record[1];
			const filePath = record.slice(3);
			// In `-z` output a rename/copy record is followed by the original path
			// as its own NUL-separated token.
			const origPath = x === "R" || x === "C" ? tokens[++i] : undefined;
			if (x === "?" && y === "?") {
				unstaged.push({ path: filePath, kind: "untracked", area: "unstaged" });
				continue;
			}
			if (CONFLICT_STATES[`${x}${y}`]) {
				unstaged.push({ path: filePath, kind: "conflicted", area: "unstaged" });
				continue;
			}
			if (x !== " ") staged.push({ path: filePath, origPath, kind: kindFromLetter(x), area: "staged" });
			if (y !== " ") unstaged.push({ path: filePath, kind: kindFromLetter(y), area: "unstaged" });
		}
		this.unstaged = unstaged;
		this.staged = staged;
	}

	#withCounts(files: readonly ChangedFile[], counts: ReadonlyMap<string, NumstatEntry>): ChangedFile[] {
		return files.map(file => {
			const count = counts.get(file.path);
			return count ? { ...file, additions: count.additions, deletions: count.deletions } : file;
		});
	}

	async #loadHeadMetadata(sha: string): Promise<HeadCommit | null> {
		try {
			const details = await git.commitDetails(this.cwd, sha);
			const [subject = "", ...bodyLines] = details.message.split("\n");
			return {
				sha,
				shortSha: sha.slice(0, 8),
				subject,
				body: bodyLines.join("\n").trim(),
				authorName: details.author.name,
				authorEmail: details.author.email,
				authorDate: details.author.date ?? "",
				parents: details.parents,
				files: [],
				filesLoaded: false,
			};
		} catch {
			return null;
		}
	}
	/** Stream old/new sources concurrently, emitting complete lines as they arrive. */
	async streamContents(
		file: ChangedFile,
		onProgress: (update: FileStreamUpdate) => void,
		signal?: AbortSignal,
	): Promise<FileContents> {
		const stream = new DiffStream();
		let oldLineOffset = 0;
		let newLineOffset = 0;
		let lastProgress: DiffStreamProgress | null = null;
		const emit = (): void => {
			const progress = stream.progress();
			const oldLines = stream.lines(DiffSide.Old, oldLineOffset, progress.oldLines - oldLineOffset);
			const newLines = stream.lines(DiffSide.New, newLineOffset, progress.newLines - newLineOffset);
			const stateChanged =
				lastProgress === null ||
				progress.stableCommonLines !== lastProgress.stableCommonLines ||
				progress.oldDone !== lastProgress.oldDone ||
				progress.newDone !== lastProgress.newDone ||
				progress.binary !== lastProgress.binary ||
				progress.tooLarge !== lastProgress.tooLarge;
			if (oldLines.length > 0 || newLines.length > 0 || stateChanged) {
				onProgress({ oldLineOffset, oldLines, newLineOffset, newLines, progress });
			}
			oldLineOffset = progress.oldLines;
			newLineOffset = progress.newLines;
			lastProgress = progress;
		};
		const empty = (side: DiffSide): Promise<void> => {
			stream.finishSide(side);
			emit();
			return Promise.resolve();
		};

		let oldSource: Promise<void>;
		let newSource: Promise<void>;
		switch (file.area) {
			case "unstaged":
				oldSource =
					file.kind === "untracked"
						? empty(DiffSide.Old)
						: this.#streamGitSide(stream, DiffSide.Old, `:0:${file.path}`, emit, signal);
				newSource = this.#streamFileSide(stream, DiffSide.New, path.join(this.cwd, file.path), emit, signal);
				break;
			case "staged":
				oldSource = this.#streamGitSide(stream, DiffSide.Old, `HEAD:${file.origPath ?? file.path}`, emit, signal);
				newSource = this.#streamGitSide(stream, DiffSide.New, `:0:${file.path}`, emit, signal);
				break;
			case "commit": {
				const head = this.headCommit;
				const base = head?.parents[0];
				oldSource = base
					? this.#streamGitSide(stream, DiffSide.Old, `${base}:${file.origPath ?? file.path}`, emit, signal)
					: empty(DiffSide.Old);
				newSource = head
					? this.#streamGitSide(stream, DiffSide.New, `${head.sha}:${file.path}`, emit, signal)
					: empty(DiffSide.New);
				break;
			}
		}
		await Promise.all([oldSource, newSource]);
		const progress = stream.progress();
		const oldText = stream.text(DiffSide.Old);
		const newText = stream.text(DiffSide.New);
		const streamResult = progress.binary || progress.tooLarge ? null : await stream.finish(DIFF_CONTEXT_LINES);
		return {
			oldText,
			newText,
			binary: progress.binary,
			tooLarge: progress.tooLarge,
			streamResult,
		};
	}

	async #streamGitSide(
		stream: DiffStream,
		side: DiffSide,
		spec: string,
		emit: () => void,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			for await (const chunk of git.show.stream(this.cwd, spec, { maxOutputBytes: MAX_FILE_BYTES, signal })) {
				const progress = stream.pushBytes(side, chunk);
				emit();
				if (progress.binary) break;
			}
			stream.finishSide(side);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof git.GitOutputTruncatedError) {
				stream.markTooLarge(side);
			} else if (error instanceof git.GitCommandError) {
				// Added files have no base-side object; preserve the previous
				// empty-side fallback while still surfacing cancellation above.
				stream.finishSide(side);
			} else {
				throw error;
			}
		}
		emit();
	}

	async #streamFileSide(
		stream: DiffStream,
		side: DiffSide,
		filePath: string,
		emit: () => void,
		signal?: AbortSignal,
	): Promise<void> {
		let done = false;
		const reading = stream.openFile(side, filePath, MAX_FILE_BYTES, signal);
		reading.then(
			() => {
				done = true;
			},
			() => {
				done = true;
			},
		);
		while (!done) {
			await Bun.sleep(4);
			emit();
		}
		await reading;
		emit();
	}

	/** Stage one file (or everything when `file` is omitted). */
	async stage(file?: ChangedFile): Promise<void> {
		await git.stage.files(this.cwd, file ? [file.path] : []);
	}

	/** Unstage one file (or everything when `file` is omitted). */
	async unstage(file?: ChangedFile): Promise<void> {
		await git.stage.reset(this.cwd, file ? [file.path] : []);
	}

	/** Create (or amend) a commit from the staged changes. */
	async commit(message: string, options: { amend?: boolean } = {}): Promise<void> {
		await git.commit(this.cwd, message, { amend: options.amend });
	}
	/** Apply a patch to the index (`cached`) and/or worktree; `reverse` undoes it. */
	async applyPatch(patchText: string, options: { cached?: boolean; reverse?: boolean } = {}): Promise<void> {
		await git.patch.applyText(this.cwd, patchText, options);
	}
}
