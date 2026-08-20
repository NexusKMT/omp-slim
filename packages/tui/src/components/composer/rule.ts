/**
 * Single-rule composer: a borderless prompt docked below one top rule. The
 * right status group rides the rule while the left group remains below the
 * editor, preserving the compact status split without a closing rule.
 */
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

/** Draw a full-width rule with optional status content docked at its right edge. */
export function renderTopRule(ctx: ComposerChromeContext): string {
	const { box, width, borderColor, topBorder } = ctx;
	if (topBorder && topBorder.width > 0 && topBorder.width <= width - 2) {
		const leftFill = Math.max(0, width - topBorder.width - 1);
		return borderColor(box.horizontal.repeat(leftFill)) + topBorder.content + borderColor(box.horizontal);
	}
	return borderColor(box.horizontal.repeat(width));
}

/** Composer style with one status-bearing top rule and no bottom chrome. */
export const ruleComposerStyle: ComposerStyle = {
	id: "rule",
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: true,
	defaultPromptGutter: "❯ ",

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return renderTopRule(ctx);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
