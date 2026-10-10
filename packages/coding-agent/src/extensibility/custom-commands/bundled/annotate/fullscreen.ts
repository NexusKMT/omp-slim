import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type {
	CodeReviewOverlayResult,
	TextReviewOverlayResult,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { ResolvedReviewTarget } from "../review/target";
import { resolveReadPath } from "../../../../tools/path-utils";
import { getEditorCommand, openEditorOnPath, openInEditor } from "../../../../utils/external-editor";

const ANNOTATION_OVERLAY_OPTIONS = {
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
	mouseTracking: false,
} as const;

const MISSING_EDITOR = "Set $VISUAL or $EDITOR to edit in an external editor.";

function requireEditor(): string {
	const editor = getEditorCommand();
	if (!editor) throw new Error(MISSING_EDITOR);
	return editor;
}

async function editAnnotationDraft(tui: TUI, draft: string, commit: (text: string | null) => void): Promise<void> {
	const editor = requireEditor();
	tui.stop();
	try {
		commit(await openInEditor(editor, draft, { extension: ".md" }));
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

async function editTextSource(
	tui: TUI,
	ctx: CustomCommandContext,
	overlay: AnnotationOverlay,
	source: TextReviewSource,
): Promise<void> {
	const editor = requireEditor();
	const filePath = source.provenance?.kind === "file" ? source.provenance.path : undefined;
	tui.stop();
	try {
		let next: string | null;
		if (filePath) {
			await openEditorOnPath(editor, filePath);
			next = await Bun.file(filePath).text();
		} else {
			next = await openInEditor(editor, overlay.textSourceText() ?? source.text, {
				extension: ".txt",
				trimTrailingNewline: false,
			});
		}
		if (next === null) return;
		source.text = next;
		const dropped = overlay.replaceTextSource(next);
		if (dropped > 0) {
			ctx.ui.notify(
				dropped === 1
					? "Dropped 1 line note that no longer matches the edited text."
					: `Dropped ${dropped} line notes that no longer match the edited text.`,
				"warning",
			);
		}
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

async function editReviewedFile(tui: TUI, ctx: CustomCommandContext, overlay: AnnotationOverlay): Promise<void> {
	const relative = overlay.reviewFilePath();
	if (!relative) throw new Error("No file to open.");
	const editor = requireEditor();
	// Diff paths are repository-relative, so resolve them from the repo root, not the session cwd.
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const absolute = resolveReadPath(relative, vcs.repo(cwd)?.root() ?? cwd);
	if (!(await Bun.file(absolute).exists())) {
		throw new Error(`${relative} is not on disk. The review still uses the frozen diff.`);
	}
	tui.stop();
	try {
		await openEditorOnPath(editor, absolute);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
	ctx.ui.notify(`Opened ${relative}. The review still uses the frozen diff.`, "info");
}

/** Mount the frozen diff in the TUI overlay surface owned by the command host. */
export function showCodeReviewOverlay(
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
	return ctx.ui.custom<CodeReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const overlay = new AnnotationOverlay(tui, theme, keybindings, target.snapshot.files, target.mode, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
				onExternalEditor: () => editReviewedFile(tui, ctx, overlay),
			});
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}

/** Mount a frozen text source in the same annotation overlay UX. */
export function showTextReviewOverlay(
	ctx: CustomCommandContext,
	source: TextReviewSource,
): Promise<TextReviewOverlayResult | undefined> {
	return ctx.ui.custom<TextReviewOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const overlay = new AnnotationOverlay(tui, theme, keybindings, source, {
				onComplete: done,
				onWarning: message => ctx.ui.notify(message, "warning"),
				onAnnotationExternalEditor: (draft, commit) => editAnnotationDraft(tui, draft, commit),
				onExternalEditor: () => editTextSource(tui, ctx, overlay, source),
			});
			return overlay;
		},
		{ overlay: true, overlayOptions: ANNOTATION_OVERLAY_OPTIONS },
	);
}
