/**
 * Clipboard register support for `CUT` / `COPY` / `PASTE` ops.
 *
 * `CUT N.=M` / `COPY N.=M` (and their `.BLK` block-resolved forms) capture the
 * range's current lines into a {@link Clipboard} register — cut additionally
 * lowers to ordinary per-line deletes at parse/resolve time. `PASTE.PRE|POST N`,
 * `PASTE.HEAD|TAIL`, and `PASTE.BLK.POST N` insert the captured lines at a
 * cursor. The register is threaded through a whole patch application in source
 * order — across sections — so content can move between files without being
 * retyped: the last capture wins, and a `PASTE` does not consume the register,
 * so the same content can land in several places.
 *
 * {@link resolveClipboardEdits} is the applier's pre-pass: it runs inside
 * {@link applyEdits} against the exact text the edits apply to (after block
 * resolution and recovery remapping), captures `copy` edits, and expands
 * `paste` edits into plain inserts.
 */
import { HL_COPY_KEYWORD, HL_CUT_KEYWORD, HL_RANGE_SEP } from "./format";
import { EMPTY_PASTE, overwrittenCutMessage, unusedCutMessage } from "./messages";
import { cloneCursor } from "./tokenizer";
import type { Clipboard, Edit } from "./types";

type CopyEdit = Extract<Edit, { kind: "copy" }>;

/** `CUT 5.=10` / `COPY 5` display form for diagnostics. */
function describeCopyEdit(edit: CopyEdit): string {
	const { start, end } = edit.range;
	const range = start.line === end.line ? `${start.line}` : `${start.line}${HL_RANGE_SEP}${end.line}`;
	return `${edit.cut ? HL_CUT_KEYWORD : HL_COPY_KEYWORD} ${range}`;
}

/** True when at least one edit reads or writes the clipboard register (including unresolved `.BLK` forms). */
export function hasClipboardEdit(edits: readonly Edit[]): boolean {
	return edits.some(
		edit =>
			edit.kind === "copy" ||
			edit.kind === "paste" ||
			(edit.kind === "block" && (edit.mode === "copy" || edit.mode === "cut" || edit.mode === "paste_after")),
	);
}
/** Optional knobs for {@link resolveClipboardEdits}. */
export interface ResolveClipboardEditsOptions {
	/** `PASTE` with an empty register: `throw` (default) or `drop` (streaming previews). */
	onEmptyPaste?: "throw" | "drop";
}

/**
 * Expand clipboard edits against `fileLines` (the text the edit batch applies
 * to): `copy` edits capture their range into `clipboard` and emit nothing;
 * `paste` edits become one plain insert per captured line. Non-clipboard edits
 * pass through untouched, and the fast path returns the input unchanged when
 * there is nothing to resolve. Edits are processed in array order — the
 * authored patch order — so a `PASTE` uses the most recent capture above it.
 *
 * Throws on an out-of-range capture, a capture that would overwrite un-pasted
 * `CUT` content, and (unless `onEmptyPaste: "drop"`) a `PASTE` with an empty
 * register.
 */
export function resolveClipboardEdits(
	edits: readonly Edit[],
	fileLines: readonly string[],
	clipboard: Clipboard,
	options: ResolveClipboardEditsOptions = {},
): readonly Edit[] {
	if (!hasClipboardEdit(edits)) return edits;
	const onEmptyPaste = options.onEmptyPaste ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind === "copy") {
			const { start, end } = edit.range;
			if (start.line < 1 || end.line > fileLines.length) {
				throw new Error(
					`line ${edit.lineNum}: \`${describeCopyEdit(edit)}\` is out of range (file has ${fileLines.length} lines).`,
				);
			}
			if (clipboard.pendingCut !== undefined) {
				throw new Error(overwrittenCutMessage(clipboard.pendingCut, edit.lineNum));
			}
			clipboard.lines = fileLines.slice(start.line - 1, end.line);
			if (edit.cut) clipboard.pendingCut = describeCopyEdit(edit);
			else delete clipboard.pendingCut;
			continue;
		}
		if (edit.kind === "paste") {
			const lines = clipboard.lines;
			if (lines === undefined) {
				if (onEmptyPaste === "drop") continue;
				throw new Error(`line ${edit.lineNum}: ${EMPTY_PASTE}`);
			}
			delete clipboard.pendingCut;
			for (const text of lines) {
				resolved.push({
					kind: "insert",
					cursor: cloneCursor(edit.cursor),
					text,
					lineNum: edit.lineNum,
					index: synthIndex++,
					...(edit.blockStart === undefined ? {} : { blockStart: edit.blockStart }),
				});
			}
			continue;
		}
		resolved.push(edit);
	}
	return resolved;
}

/**
 * Shallow working copy of a register, for transactional batches: resolve the
 * whole batch against the fork, then {@link commitClipboard} it back only
 * after the batch's writes actually land. A failed batch leaves the source
 * register untouched, so retries are never blocked by phantom captures and a
 * failed `PASTE` never clears a real pending cut.
 */
export function forkClipboard(source?: Clipboard): Clipboard {
	return source === undefined ? {} : { ...source };
}

/** Publish a fork's state back to its source register. */
export function commitClipboard(fork: Clipboard, target: Clipboard): void {
	if (fork.lines === undefined) delete target.lines;
	else target.lines = fork.lines;
	if (fork.pendingCut === undefined) delete target.pendingCut;
	else target.pendingCut = fork.pendingCut;
}

/**
 * Throw when the register still holds un-pasted `CUT` content. Called at the
 * end of a batch by whoever created the register: a cut that never landed
 * means the patch deleted lines it meant to move (the classic truncated-patch
 * failure), so it is rejected rather than silently applied as a delete.
 */
export function assertClipboardConsumed(clipboard: Clipboard): void {
	if (clipboard.pendingCut !== undefined) throw new Error(unusedCutMessage(clipboard.pendingCut));
}

/**
 * Validate clipboard sequencing (a `PASTE` before any capture, a capture over
 * un-pasted `CUT` content) without mutating `clipboard` or touching file text.
 * The patcher runs this before its recovery path, where {@link applyEdits}
 * failures are swallowed and re-surfaced as tag-mismatch errors — sequencing
 * mistakes must keep their targeted message instead.
 */
export function validateClipboardSequence(edits: readonly Edit[], clipboard: Clipboard): void {
	let hasLines = clipboard.lines !== undefined;
	let pendingCut = clipboard.pendingCut;
	for (const edit of edits) {
		if (edit.kind === "copy") {
			if (pendingCut !== undefined) throw new Error(overwrittenCutMessage(pendingCut, edit.lineNum));
			hasLines = true;
			pendingCut = edit.cut ? describeCopyEdit(edit) : undefined;
		} else if (edit.kind === "paste") {
			if (!hasLines) throw new Error(`line ${edit.lineNum}: ${EMPTY_PASTE}`);
			pendingCut = undefined;
		}
	}
}
