/**
 * Exa TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for Exa search results.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../../custom-tools/types";
import { logger } from "../../logger";
import type { ExaRenderDetails } from "./types";

/** Truncate text to max length with ellipsis */
function truncate(text: string, maxLen: number, ellipsis: string): string {
	if (text.length <= maxLen) return text;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${text.slice(0, sliceLen)}${ellipsis}`;
}

/** Extract domain from URL */
function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Get first N lines of text as preview */
function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis: string): string[] {
	const lines = text.split("\n").filter((l) => l.trim());
	return lines.slice(0, maxLines).map((l) => truncate(l.trim(), maxLineLen, ellipsis));
}

/** Render Exa result with tree-based layout */
export function renderExaResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExaRenderDetails },
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const { expanded } = options;
	const details = result.details;

	// Handle error case
	if (details?.error) {
		logger.error("Exa render error", { error: details.error, toolName: details.toolName });
		return new Text(uiTheme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const response = details?.response;
	if (!response) {
		// Non-search response: show raw result
		if (details?.raw) {
			const rawText = typeof details.raw === "string" ? details.raw : JSON.stringify(details.raw, null, 2);
			const preview = expanded ? rawText : truncate(rawText, 200, uiTheme.format.ellipsis);
			const toolLabel = details?.toolName ?? "Exa";
			return new Text(
				`${uiTheme.fg("success", uiTheme.format.bullet)} ${uiTheme.fg("toolTitle", toolLabel)}\n ${uiTheme.fg("dim", uiTheme.tree.vertical)}  ${preview}`,
				0,
				0,
			);
		}
		return new Text(uiTheme.fg("error", "No response data"), 0, 0);
	}

	const results = response.results ?? [];
	const resultCount = results.length;
	const cost = response.costDollars?.total;
	const time = response.searchTime;

	// Build header: Exa Search · N results · $X.XX · Xs
	const icon =
		resultCount > 0 ? uiTheme.fg("success", uiTheme.format.bullet) : uiTheme.fg("warning", uiTheme.format.bullet);
	const expandHint = expanded ? "" : uiTheme.fg("dim", " (Ctrl+O to expand)");
	const toolLabel = details?.toolName ?? "Exa Search";

	let headerParts = `${icon} ${uiTheme.fg("toolTitle", toolLabel)}${uiTheme.sep.dot}${uiTheme.fg(
		"dim",
		`${resultCount} result${resultCount !== 1 ? "s" : ""}`,
	)}`;

	if (cost !== undefined) {
		headerParts += `${uiTheme.sep.dot}${uiTheme.fg("muted", `$${cost.toFixed(4)}`)}`;
	}
	if (time !== undefined) {
		headerParts += `${uiTheme.sep.dot}${uiTheme.fg("muted", `${time.toFixed(2)}s`)}`;
	}

	let text = headerParts + expandHint;

	if (!expanded) {
		// Collapsed view: show 3-line preview from first result
		if (resultCount > 0) {
			const first = results[0];
			const previewText = first.text ?? first.title ?? "";
			const previewLines = getPreviewLines(previewText, 3, 100, uiTheme.format.ellipsis);

			for (const line of previewLines) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.vertical)}  ${uiTheme.fg("dim", line)}`;
			}

			const totalLines = previewText.split("\n").filter((l) => l.trim()).length;
			if (totalLines > 3) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.vertical)}  ${uiTheme.fg(
					"muted",
					`${uiTheme.format.ellipsis} ${totalLines - 3} more lines`,
				)}`;
			}

			if (resultCount > 1) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
					"muted",
					`${resultCount - 1} more result${resultCount !== 2 ? "s" : ""}`,
				)}`;
			}
		}
	} else {
		// Expanded view: full results tree
		if (resultCount > 0) {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.vertical)}`;
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("accent", "Results")}`;

			for (let i = 0; i < results.length; i++) {
				const res = results[i];
				const isLast = i === results.length - 1;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				const cont = isLast ? " " : uiTheme.tree.vertical;

				// Title + domain
				const title = truncate(res.title ?? "Untitled", 60, uiTheme.format.ellipsis);
				const domain = res.url ? getDomain(res.url) : "";
				const domainPart = domain ? uiTheme.fg("dim", ` (${domain})`) : "";

				text += `\n ${uiTheme.fg("dim", " ")} ${uiTheme.fg("dim", branch)} ${uiTheme.fg("accent", title)}${domainPart}`;

				// URL
				if (res.url) {
					text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg("mdLinkUrl", res.url)}`;
				}

				// Author
				if (res.author) {
					text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg("muted", `Author: ${res.author}`)}`;
				}

				// Published date
				if (res.publishedDate) {
					text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg("muted", `Published: ${res.publishedDate}`)}`;
				}

				// Text content
				if (res.text) {
					const textLines = res.text.split("\n").filter((l) => l.trim());
					const displayLines = textLines.slice(0, 5); // Show first 5 lines
					for (const line of displayLines) {
						text += `\n ${uiTheme.fg("dim", cont)}   ${truncate(line.trim(), 90, uiTheme.format.ellipsis)}`;
					}
					if (textLines.length > 5) {
						text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg(
							"muted",
							`${uiTheme.format.ellipsis} ${textLines.length - 5} more lines`,
						)}`;
					}
				}

				// Highlights
				if (res.highlights?.length) {
					text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg("accent", "Highlights:")}`;
					for (let j = 0; j < Math.min(res.highlights.length, 3); j++) {
						const h = res.highlights[j];
						text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg(
							"muted",
							`${uiTheme.format.bullet} ${truncate(h, 80, uiTheme.format.ellipsis)}`,
						)}`;
					}
					if (res.highlights.length > 3) {
						text += `\n ${uiTheme.fg("dim", cont)}   ${uiTheme.fg(
							"muted",
							`${uiTheme.format.ellipsis} ${res.highlights.length - 3} more`,
						)}`;
					}
				}
			}
		}
	}

	return new Text(text, 0, 0);
}

/** Render Exa call (query/args preview) */
export function renderExaCall(args: Record<string, unknown>, toolName: string, uiTheme: Theme): Component {
	const query = typeof args.query === "string" ? truncate(args.query, 80, uiTheme.format.ellipsis) : "";
	const numResults = typeof args.num_results === "number" ? args.num_results : undefined;
	const detail = numResults ? uiTheme.fg("dim", ` (${numResults} results)`) : "";

	const text = `${uiTheme.fg("toolTitle", toolName)} ${uiTheme.fg("muted", query)}${detail}`;
	return new Text(text, 0, 0);
}
