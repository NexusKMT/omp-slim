/**
 * Markdown documents shared by the renderer's windowing tests.
 */

import { LEX_WINDOW_BYTES } from "../src/components/markdown";

/** The renderer's first probe window. */
export const FIRST_PROBE_WINDOW = LEX_WINDOW_BYTES;

/**
 * `Intro.`, then a construct (`open`, lines one blank line apart, `close`), then
 * `rest`. The lines are padded so that a `"\n\n"` inside the construct ends
 * exactly at FIRST_PROBE_WINDOW, where a probe that stops at the window's end
 * would cut it.
 */
export function straddleFirstWindow(open: string, line: (i: number) => string, close: string, rest: string): string {
	const prefix = `Intro.\n\n${open}\n`;
	let body = "";
	let i = 0;
	while (prefix.length + body.length < FIRST_PROBE_WINDOW - 60) body += `${line(i++)}\n\n`;
	const straddle = `${"y".repeat(FIRST_PROBE_WINDOW - prefix.length - body.length - 2)}\n\n${line(i)}\n`;
	// The padding above is only useful if the blank line it targets actually
	// lands at the window edge; assert that so a retuned FIRST_PROBE_WINDOW
	// fails loudly here instead of silently stopping to cover the
	// `tokenEnd < windowEnd` guard the straddle tests exist to exercise.
	const blankEnd = prefix.length + body.length + straddle.indexOf("\n\n") + 2;
	if (blankEnd !== FIRST_PROBE_WINDOW) {
		throw new Error(
			`straddleFirstWindow: blank line ends at ${blankEnd}, expected FIRST_PROBE_WINDOW (${FIRST_PROBE_WINDOW})`,
		);
	}
	return `${prefix}${body}${straddle}${close}\n\n${rest}`;
}
