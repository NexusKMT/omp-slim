/**
 * Claude Code-like composer: full-width horizontal rules above and below a
 * borderless `❯ ` prompt. The right status group rides the top rule as a
 * bg chip near the right edge (`─────── hi ─`); the left group renders as a
 * plain standalone bottom bar that yields its row to the autocomplete menu.
 */
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

export const claudeComposerStyle: ComposerStyle = {
	id: "claude",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	defaultPromptGutter: "❯ ",

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		const { box, width, borderColor, topBorder } = ctx;
		// Attach the status chip near the right edge, one trailing rule cell:
		// `─────────────── hi ─`.
		if (topBorder && topBorder.width > 0 && topBorder.width <= width - 2) {
			const leftFill = Math.max(0, width - topBorder.width - 1);
			return borderColor(box.horizontal.repeat(leftFill)) + topBorder.content + borderColor(box.horizontal);
		}
		return borderColor(box.horizontal.repeat(width));
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},
};
