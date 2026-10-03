/**
 * Removal of DeepSeek DSML tool-call markup left in visible assistant text.
 *
 * DeepSeek models on OpenAI-compatible hosts sometimes emit their tool calls as
 * raw `<｜DSML｜…>` markup in `content`. A well-formed envelope is healed into a
 * structured call by `StreamMarkupHealing`, but a degraded model can drop the
 * opening `<｜DSML｜tool_calls>` / `<｜DSML｜invoke name="…">` tags (or the host
 * runs no healer at all). That markup must not stay in history: replaying it
 * teaches the model to keep writing tool calls as text (issue #10556). Callers
 * strip it before the message is committed and tell the model its call failed.
 */

import type { AssistantMessage } from "../types";

// Structural DSML tags in either pipe spelling (fullwidth `｜` U+FF5C or ASCII),
// tolerating stray whitespace inside the delimiter run.
const DSML_TAG_PATTERN = /<\s*\/?\s*[｜|]\s*DSML\s*[｜|]\s*(?:tool_calls|invoke|parameter)\b[^<>]*>?/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;
const CLOSING_TAG_PATTERN = /^<\s*\//;

/**
 * Remove the broken tool call from one stretch of unquoted text: everything from
 * the first DSML tag (or the tool-name line just before it) through the last.
 * When the last tag is an opener, its argument value has no surviving closer
 * (the stream healer strips orphan closers), so the call runs to the end of
 * the stretch.
 */
function stripUnquoted(text: string): string {
	const tags = [...text.matchAll(DSML_TAG_PATTERN)];
	if (tags.length === 0) return text;
	const first = tags[0]!;
	const last = tags[tags.length - 1]!;
	let start = first.index;
	const nameLine = TRAILING_TOOL_NAME_LINE.exec(text.slice(0, start));
	if (nameLine) start = nameLine.index + nameLine[1]!.length;
	const end = CLOSING_TAG_PATTERN.test(last[0]) ? last.index + last[0].length : text.length;
	const before = text.slice(0, start).trimEnd();
	const after = text.slice(end).trimStart();
	return before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : before + after;
}

/**
 * Strip leaked DSML tool-call markup from `text`, leaving quoted code intact.
 * Returns `undefined` when `text` carries no such markup.
 */
export function stripDsmlToolMarkup(text: string): string | undefined {
	if (!text.includes("DSML")) return undefined;
	let out = "";
	let cursor = 0;
	let changed = false;
	const flush = (end: number): void => {
		const segment = text.slice(cursor, end);
		const stripped = stripUnquoted(segment);
		if (stripped !== segment) changed = true;
		out += stripped;
	};
	for (const quoted of text.matchAll(QUOTED_CODE_PATTERN)) {
		flush(quoted.index);
		out += quoted[0];
		cursor = quoted.index + quoted[0].length;
	}
	flush(text.length);
	return changed ? out : undefined;
}

/**
 * Remove leaked DSML tool-call markup from `message`'s text blocks in place,
 * dropping blocks left empty. Returns true when anything was removed.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let removed = false;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		const stripped = block.type === "text" ? stripDsmlToolMarkup(block.text) : undefined;
		if (block.type !== "text" || stripped === undefined) {
			content.push(block);
			continue;
		}
		removed = true;
		if (stripped.trim().length > 0) content.push({ ...block, text: stripped });
	}
	if (removed) message.content = content;
	return removed;
}
