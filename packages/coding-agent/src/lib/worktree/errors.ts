export enum WorktreeErrorCode {
	NOT_GIT_REPO = "NOT_GIT_REPO",
	WORKTREE_NOT_FOUND = "WORKTREE_NOT_FOUND",
	WORKTREE_EXISTS = "WORKTREE_EXISTS",
	CANNOT_MODIFY_MAIN = "CANNOT_MODIFY_MAIN",
	NO_CHANGES = "NO_CHANGES",
	COLLAPSE_FAILED = "COLLAPSE_FAILED",
	REBASE_CONFLICTS = "REBASE_CONFLICTS",
	APPLY_FAILED = "APPLY_FAILED",
	OVERLAPPING_SCOPES = "OVERLAPPING_SCOPES",
}

export class WorktreeError extends Error {
	readonly code: WorktreeErrorCode;
	readonly cause?: Error;

	constructor(message: string, code: WorktreeErrorCode, cause?: Error) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
		this.cause = cause;
	}
}
