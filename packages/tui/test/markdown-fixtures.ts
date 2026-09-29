/**
 * Markdown documents shared by the renderer's windowing tests.
 */

/** The renderer's first probe window: `LEX_WINDOW_BYTES` in components/markdown.ts. */
export const FIRST_PROBE_WINDOW = 2048;

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
	body += `${"y".repeat(FIRST_PROBE_WINDOW - prefix.length - body.length - 2)}\n\n${line(i)}\n`;
	return `${prefix}${body}${close}\n\n${rest}`;
}
