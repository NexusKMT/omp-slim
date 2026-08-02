/**
 * In-session fallbacks for permission-denied file writes and deletes.
 *
 * A host that embeds the agent inside an OS sandbox can grant a path mid-session
 * but cannot apply that grant to an in-process write, because the write happens
 * in the agent process under a profile fixed at launch. This module gives such a
 * host a seam to intercept a denied mutation and perform it through a privileged
 * channel, without reimplementing `write`/`edit` semantics: the native tool still
 * records its own snapshot under the real destination path once the fallback
 * reports success, so a follow-up hashline `edit` on that path keeps working.
 *
 * Writes and deletes have SEPARATE registries. A write handler brokers `content`
 * to `dst`, so a delete request reaching it with no content invites brokering an
 * empty write and truncating the file it was asked to remove. Opting into deletes
 * is therefore explicit; see {@link addFileDeleteFallback}.
 *
 * ## What is routed
 *
 * The byte-write that `write`, `edit` and `apply_patch` perform on an ordinary
 * file path goes through the same two-line primitive
 * (`file ? file.write(content) : Bun.write(dst, content)`). It has four call
 * sites, and all of them route here:
 *
 * - `writethroughNoop` and `runLspWritethrough`'s `writeContent` (`lsp/writethrough.ts`),
 *   the `WritethroughCallback` that `write` and `edit` both write through.
 *   `apply_patch` reaches it too: `LspFileSystem.write` (`edit/modes/patch.ts`),
 *   which it always injects, delegates to the same callback.
 * - `HashlineFilesystem.move` (`edit/hashline/filesystem.ts`) — a hashline `MV`
 *   destination, the one `edit` write that does not pass through the writethrough.
 * - `defaultFileSystem.write` (`edit/modes/patch.ts`), only the default parameter
 *   for external `applyPatch` callers and tests.
 *
 * `apply_patch` also creates a missing parent directory before writing, via its
 * filesystem's `mkdir`. That `mkdir` consults {@link hasFileWriteFallback} so a
 * denial there falls through to the write and reaches a handler, instead of
 * throwing before the seam is ever consulted.
 *
 * The unlink that `edit` and `apply_patch` perform routes to the separate delete
 * seam ({@link deleteFileWithFallback}) at four sites: `HashlineFilesystem.delete`
 * (`edit`'s `REM`) and `HashlineFilesystem.move`'s source unlink, plus
 * `LspFileSystem.delete` and `defaultFileSystem.delete` for `apply_patch`.
 *
 * ## What is NOT routed
 *
 * This is deliberately not an exhaustive interception of every syscall the tools
 * can make. A permission error from any of these surfaces as it does today:
 *
 * - `write` to an archive member (`foo.zip:entry`) or a SQLite row. Neither is a
 *   byte-write to `dst`: an archive member rewrite reads the whole archive, sets
 *   one entry, writes a temp file and renames over the original, so the bytes on
 *   disk are a whole binary container rather than the string the tool was given;
 *   a SQLite write is a row operation inside the database engine with no byte
 *   payload at all. Brokering either needs a different request shape than
 *   "these exact bytes belong at this path".
 * - `acp-bridge.ts`'s `bridge.writeTextFile` — a remote-client transport.
 * - Removing a DIRECTORY is never the intent: the delete seam refuses to divert a
 *   target it can confirm is one, and reports `confirmedFile: false` when the
 *   target's metadata is behind the same boundary and the check cannot be resolved.
 * - The `lsp` tool's own writes: applying a workspace edit or a code action
 *   (`lsp/edits.ts`), and the Biome formatter, which writes the buffer and then
 *   shells out to `biome format --write` (`lsp/clients/biome-client.ts`) — a
 *   subprocess write no in-process seam can reach anyway.
 *
 * ## Diverting
 *
 * Only a permission boundary diverts — `EPERM`, `EACCES`, `EROFS`, plus the one
 * case where Bun hides such a denial behind an `ENOENT` (see
 * {@link classifyWriteFailure}). Every other error rethrows untouched.
 *
 * With no handler registered this module is inert: the primitive runs exactly as
 * it did before, a failure rethrows from the same place, and no extra syscalls
 * are performed.
 *
 * ## Scope of the registry
 *
 * Handlers live in one process-wide list, and a process can host several sessions
 * (a subagent gets its own `ExtensionRunner`). A handler is therefore consulted
 * for denied writes from ANY session in the process, not only the one whose
 * extension registered it, and `FileWriteFallbackRequest` carries no session
 * identity to distinguish them. A handler whose policy depends on which session
 * asked must not assume its own; brokering the bytes is session-independent and
 * is the intended use.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError, logger } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import type { ExtensionContext } from "../extensibility/extensions/types";

/** A denied write, captured for a registered fallback to retry through a privileged channel. */
export interface FileWriteFallbackRequest {
	/** Absolute destination path the write was denied for. */
	dst: string;
	/** The exact bytes the tool intended to write. */
	content: string;
	/**
	 * The error that proves the write hit a permission boundary. Usually the write's
	 * own `EPERM`/`EACCES`/`EROFS`; for a write into a directory the host may not
	 * create, the denial raised by creating that directory, in which case `dst`'s
	 * parent may not exist yet and the handler is responsible for creating it.
	 */
	cause: unknown;
}

/** Extension-authored handler. Return `true` once `content` is durably on disk at `dst`. */
export type FileWriteFallbackHandler = (req: FileWriteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

/** A handler already bound to its owning extension's live context. */
type BoundFileWriteFallbackHandler = (req: FileWriteFallbackRequest) => Promise<boolean>;

/** A denied unlink, captured for a registered fallback to perform through a privileged channel. */
export interface FileDeleteFallbackRequest {
	/** Absolute path the unlink was denied for. */
	dst: string;
	/** The `EPERM`/`EACCES`/`EROFS` that proves the unlink hit a permission boundary. */
	cause: unknown;
	/**
	 * Whether `dst` was confirmed to be a plain regular file before diverting.
	 *
	 * `false` means the seam could not establish that, either because the target's
	 * own metadata is behind the same boundary that denied the unlink — the common
	 * sandbox case, since `unlink` on a directory also reports `EPERM` on Darwin —
	 * or because `dst` is a symlink.
	 *
	 * A handler MUST remove `dst` with a plain unlink. It MUST NOT remove it
	 * recursively, and MUST NOT resolve the path first: when this is `false` the
	 * target may be a directory, and resolving a symlink would delete whatever it
	 * points at instead of the link.
	 */
	confirmedFile: boolean;
}

/** Extension-authored handler. Return `true` once `dst` is gone from disk. */
export type FileDeleteFallbackHandler = (req: FileDeleteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

/** A handler already bound to its owning extension's live context. */
type BoundFileDeleteFallbackHandler = (req: FileDeleteFallbackRequest) => Promise<boolean>;

const PERMISSION_DENIED_CODES: Record<string, true> = { EPERM: true, EACCES: true, EROFS: true };
const PERMISSION_DENIED_MESSAGE = /\b(EPERM|EACCES|EROFS)\b/;

/** True for `EPERM`, `EACCES`, and `EROFS` — the sandbox-boundary write failures this seam exists for. */
export function isPermissionDeniedError(error: unknown): boolean {
	// A structured `code` is authoritative. Checking the message as well would
	// misclassify any error whose path contains one of these names, and Bun embeds
	// the full path in its fs error messages (`ENOENT: ..., open '/x/EACCES/y'`).
	if (isFsError(error)) return PERMISSION_DENIED_CODES[error.code] === true;
	// Some write paths (e.g. a bridged transport) surface the denial as a plain
	// Error with no structured `code`, leaving only the message to go on.
	return error instanceof Error && PERMISSION_DENIED_MESSAGE.test(error.message);
}

const fallbackHandlers: BoundFileWriteFallbackHandler[] = [];

/** Whether any fallback is registered. Lets a caller skip work that only this seam needs. */
export function hasFileWriteFallback(): boolean {
	return fallbackHandlers.length > 0;
}

/**
 * Append a fallback writer, consulted in registration order when a direct write is
 * permission-denied. Returns a disposer that removes this exact registration; the
 * runner calls it on session shutdown so no handler outlives its session.
 */
export function addFileWriteFallback(handler: BoundFileWriteFallbackHandler): () => void {
	fallbackHandlers.push(handler);
	return () => {
		const index = fallbackHandlers.indexOf(handler);
		if (index !== -1) fallbackHandlers.splice(index, 1);
	};
}

const deleteFallbackHandlers: BoundFileDeleteFallbackHandler[] = [];

/** Whether any delete fallback is registered. */
export function hasFileDeleteFallback(): boolean {
	return deleteFallbackHandlers.length > 0;
}

/**
 * Append a fallback deleter, consulted in registration order when a direct unlink is
 * permission-denied. Deliberately a separate registry from
 * {@link addFileWriteFallback}: a write handler brokers `content` to `dst`, and
 * handing it a request with no content would let it "broker" an empty write and
 * truncate the file it was asked to remove. Opting in is explicit for that reason.
 */
export function addFileDeleteFallback(handler: BoundFileDeleteFallbackHandler): () => void {
	deleteFallbackHandlers.push(handler);
	return () => {
		const index = deleteFallbackHandlers.indexOf(handler);
		if (index !== -1) deleteFallbackHandlers.splice(index, 1);
	};
}

/**
 * Remove a file, consulting registered delete fallbacks when the unlink is denied.
 *
 * Unlike the write path there is no masked-`ENOENT` case to see through: nothing is
 * created on the way, so an `ENOENT` here means the file genuinely is not there and
 * must propagate — `edit`'s `REM` turns it into a `NotFoundError`.
 */
export async function deleteFileWithFallback(dst: string, file?: BunFile): Promise<void> {
	try {
		if (file) {
			await file.unlink();
		} else {
			await fs.unlink(dst);
		}
	} catch (error) {
		if (deleteFallbackHandlers.length === 0 || !isPermissionDeniedError(error)) throw error;
		// `unlink` on a directory reports EPERM on Darwin (EISDIR on Linux), which is
		// indistinguishable from a sandbox denial by code alone, so check the target
		// before diverting: asking a privileged deleter to remove a DIRECTORY on
		// behalf of a tool that only ever removes one file would far exceed the
		// intent. `lstat` rather than `stat`, so the link itself is judged — removing
		// a symlink is a legitimate file removal, and following it here would ask the
		// wrong question.
		const stat = await fs.lstat(dst).catch((statError: unknown) => {
			// A sandbox that denies the unlink usually denies the target's metadata
			// too, so a denied `lstat` is expected here and must still divert — it
			// just leaves the question unresolved, which `confirmedFile` reports.
			// Any OTHER `lstat` failure is not something this seam should paper over.
			if (isPermissionDeniedError(statError)) return null;
			throw error;
		});
		if (stat?.isDirectory()) throw error;
		// A symlink is safe to unlink but NOT safe to resolve: a helper that
		// realpaths `dst` for auditing, or removes it recursively, would act on the
		// link's target instead. Only a plain regular file is a confirmed file.
		const confirmedFile = stat?.isFile() ?? false;
		for (const handler of deleteFallbackHandlers) {
			try {
				if (await handler({ dst, cause: error, confirmedFile })) return;
			} catch (handlerError) {
				logger.warn("File delete fallback handler threw; trying next handler", {
					dst,
					error: handlerError instanceof Error ? handlerError.message : String(handlerError),
				});
			}
		}
		throw error;
	}
}

/**
 * Outcome of inspecting a failed primitive write. `denied` diverts to the
 * registered handlers, `retry` repeats the write because this call repaired the
 * cause, and `rethrow` leaves the original error alone.
 */
type WriteFailureKind = { kind: "denied"; cause: unknown } | { kind: "retry" } | { kind: "rethrow" };

/**
 * Decide whether a failed write hit a permission boundary.
 *
 * `Bun.write` and `BunFile.write` create missing parent directories themselves,
 * but when that `mkdir` is the thing being denied they report the subsequent
 * `open()`'s `ENOENT` rather than the denial — so a sandboxed write into a new
 * out-of-tree directory is indistinguishable from an ordinary missing path.
 * Redoing the `mkdir` explicitly recovers the real errno, and because it runs
 * through the same enforcement path as the write it sees kernel-level denials
 * (Seatbelt, LSM) that a `stat`/`access` probe would report as writable.
 *
 * Only called with at least one handler registered, so a stock host never pays
 * for this.
 */
async function classifyWriteFailure(dst: string, error: unknown): Promise<WriteFailureKind> {
	if (isPermissionDeniedError(error)) return { kind: "denied", cause: error };
	if (!isEnoent(error)) return { kind: "rethrow" };
	try {
		await fs.mkdir(path.dirname(dst), { recursive: true });
	} catch (mkdirError) {
		// A denied `mkdir` is the boundary the write hid; anything else (`ENOTDIR`
		// for a file used as a directory, ...) is a genuine bad path.
		if (isPermissionDeniedError(mkdirError)) return { kind: "denied", cause: mkdirError };
		return { kind: "rethrow" };
	}
	// The parent exists now, so the `ENOENT` was a lost race rather than a
	// boundary. Any directory just created stays, matching what a permitted
	// `Bun.write` would have left behind; removing it could race a concurrent
	// writer that legitimately needs it.
	return { kind: "retry" };
}

export async function writeFileWithFallback(dst: string, content: string, file?: BunFile): Promise<void> {
	// Attempt 0 is the plain write. The single retry is reachable only when the
	// first failure turned out to be a parent-directory race this call repaired,
	// which bounds the loop at two writes.
	for (let attempt = 0; ; attempt++) {
		try {
			if (file) {
				await file.write(content);
			} else {
				await Bun.write(dst, content);
			}
			return;
		} catch (error) {
			if (fallbackHandlers.length === 0) throw error;
			// On the second attempt a `retry` verdict can no longer change the
			// outcome, so skip the probe and let the error stand unless it is a
			// denial the handlers should see.
			const failure =
				attempt === 0
					? await classifyWriteFailure(dst, error)
					: isPermissionDeniedError(error)
						? ({ kind: "denied", cause: error } as const)
						: ({ kind: "rethrow" } as const);
			if (failure.kind === "retry") continue;
			if (failure.kind === "denied") {
				// A denial reached through a SYMLINK is never brokered. The in-process
				// write follows the link, so the kernel denied the link's TARGET — but a
				// handler receives `dst`, and a privileged helper opening it with ordinary
				// follow semantics lands these bytes wherever the link points. That also
				// defeats the obvious helper-side defence: a prefix allowlist passes,
				// because the LINK sits inside the allowed root while its target does not.
				// omp cannot vouch for the destination, so it refuses rather than hand the
				// ambiguity to a privileged writer — the same answer, for the same reason,
				// that `confineToWorkspace` gives an unresolvable link
				// (`tools/path-utils.ts`).
				//
				// An unreadable `lstat` cannot prove a link, and the dangerous shape (a
				// link inside a directory the profile allows) always has readable
				// metadata, so an undecidable check never blocks the case this seam
				// exists for.
				const viaSymlink = await fs.lstat(dst).then(
					stat => stat.isSymbolicLink(),
					() => false,
				);
				if (!viaSymlink) {
					for (const handler of fallbackHandlers) {
						try {
							if (await handler({ dst, content, cause: failure.cause })) return;
						} catch (handlerError) {
							logger.warn("File write fallback handler threw; trying next handler", {
								dst,
								error: handlerError instanceof Error ? handlerError.message : String(handlerError),
							});
						}
					}
				}
			}
			// Always the ORIGINAL error, never a handler's, so behaviour matches a
			// host with no fallback registered. When the real boundary was recovered
			// from behind a masked `ENOENT`, attach it so the denial is not lost:
			// without this the caller is told `ENOENT` for a path this code has
			// already proven is `EACCES`.
			if (failure.kind === "denied" && failure.cause !== error && error instanceof Error && error.cause == null) {
				error.cause = failure.cause;
			}
			throw error;
		}
	}
}
