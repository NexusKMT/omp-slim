/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getLanguageFromPath, type Theme } from "../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../custom-tools/types";
import type { AskToolDetails } from "./ask";
import type { FindToolDetails } from "./find";
import type { GrepToolDetails } from "./grep";
import type { LsToolDetails } from "./ls";
import { renderCall as renderLspCall, renderResult as renderLspResult } from "./lsp/render";
import type { LspToolDetails } from "./lsp/types";
import type { NotebookToolDetails } from "./notebook";
import type { OutputToolDetails } from "./output";
import {
	formatBytes,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	TRUNCATE_LENGTHS,
	truncate,
} from "./render-utils";
import { renderCall as renderTaskCall, renderResult as renderTaskResult } from "./task/render";
import type { TaskToolDetails } from "./task/types";
import { renderWebFetchCall, renderWebFetchResult, type WebFetchToolDetails } from "./web-fetch";
import { renderWebSearchCall, renderWebSearchResult, type WebSearchRenderDetails } from "./web-search/render";

// Tree drawing characters

interface ToolRenderer<TArgs = any, TDetails = any> {
	renderCall(args: TArgs, theme: Theme): Component;
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
		options: RenderResultOptions,
		theme: Theme,
	): Component;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

function formatMeta(meta: string[], theme: Theme): string {
	return meta.length > 0 ? ` ${theme.fg("muted", meta.join(theme.sep.dot))}` : "";
}

function formatScope(scopePath: string | undefined, theme: Theme): string {
	return scopePath ? ` ${theme.fg("muted", `in ${scopePath}`)}` : "";
}

function formatTruncationSuffix(truncated: boolean, theme: Theme): string {
	return truncated ? theme.fg("warning", " (truncated)") : "";
}

function renderErrorMessage(_toolLabel: string, message: string, theme: Theme): Text {
	const clean = message.replace(/^Error:\s*/, "").trim();
	return new Text(
		`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", `Error: ${clean || "Unknown error"}`)}`,
		0,
		0,
	);
}

function renderEmptyMessage(_toolLabel: string, message: string, theme: Theme): Text {
	return new Text(`${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", message)}`, 0, 0);
}

// ============================================================================
// Grep Renderer
// ============================================================================

interface GrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	caseSensitive?: boolean;
	literal?: boolean;
	multiline?: boolean;
	context?: number;
	limit?: number;
	outputMode?: string;
}

const grepRenderer: ToolRenderer<GrepArgs, GrepToolDetails> = {
	renderCall(args, theme) {
		const label = theme.fg("toolTitle", theme.bold("Grep"));
		let text = `${label} ${theme.fg("accent", args.pattern || "?")}`;

		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.outputMode && args.outputMode !== "files_with_matches") meta.push(`mode:${args.outputMode}`);
		if (args.caseSensitive) {
			meta.push("case:sensitive");
		} else if (args.ignoreCase) {
			meta.push("case:insensitive");
		}
		if (args.literal) meta.push("literal");
		if (args.multiline) meta.push("multiline");
		if (args.context !== undefined) meta.push(`context:${args.context}`);
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		text += formatMeta(meta, theme);

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const label = "Grep";
		const details = result.details;

		if (details?.error) {
			return renderErrorMessage(label, details.error, theme);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return renderEmptyMessage(label, "No matches found", theme);
			}

			const lines = textContent.split("\n").filter((line) => line.trim() !== "");
			const maxLines = expanded ? lines.length : Math.min(lines.length, COLLAPSED_TEXT_LIMIT);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			const hasMore = remaining > 0;

			const icon = theme.styledSymbol("status.success", "success");
			const summary = formatCount("item", lines.length);
			const expandHint = formatExpandHint(expanded, hasMore, theme);
			let text = `${icon} ${theme.fg("dim", summary)}${expandHint}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("toolOutput", displayLines[i])}`;
			}

			if (remaining > 0) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					formatMoreItems(remaining, "item", theme),
				)}`;
			}

			return new Text(text, 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const mode = details?.mode ?? "files_with_matches";
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		if (matchCount === 0) {
			return renderEmptyMessage(label, "No matches found", theme);
		}

		const icon = theme.styledSymbol("status.success", "success");
		const summaryParts =
			mode === "files_with_matches"
				? [formatCount("file", fileCount)]
				: [formatCount("match", matchCount), formatCount("file", fileCount)];
		const summaryText = summaryParts.join(theme.sep.dot);
		const scopeLabel = formatScope(details?.scopePath, theme);

		const fileEntries: Array<{ path: string; count?: number }> = details?.fileMatches?.length
			? details.fileMatches.map((entry) => ({ path: entry.path, count: entry.count }))
			: files.map((path) => ({ path }));
		const maxFiles = expanded ? fileEntries.length : Math.min(fileEntries.length, COLLAPSED_LIST_LIMIT);
		const hasMoreFiles = fileEntries.length > maxFiles;
		const expandHint = formatExpandHint(expanded, hasMoreFiles, theme);

		let text = `${icon} ${theme.fg("dim", summaryText)}${formatTruncationSuffix(
			truncated,
			theme,
		)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.matchLimitReached) {
			truncationReasons.push(`limit ${details.matchLimitReached} matches`);
		}
		if (details?.headLimitReached) {
			truncationReasons.push(`head limit ${details.headLimitReached}`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}
		if (details?.linesTruncated) {
			truncationReasons.push("line length");
		}

		const hasTruncation = truncationReasons.length > 0;

		if (fileEntries.length > 0) {
			for (let i = 0; i < maxFiles; i++) {
				const entry = fileEntries[i];
				const isLast = i === maxFiles - 1 && !hasMoreFiles && !hasTruncation;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				const isDir = entry.path.endsWith("/");
				const entryPath = isDir ? entry.path.slice(0, -1) : entry.path;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? theme.fg("accent", theme.icon.folder)
					: theme.fg("muted", theme.getLangIcon(lang));
				const countLabel =
					entry.count !== undefined
						? ` ${theme.fg("dim", `(${entry.count} match${entry.count !== 1 ? "es" : ""})`)}`
						: "";
				text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg("accent", entry.path)}${countLabel}`;
			}

			if (hasMoreFiles) {
				const moreFilesBranch = hasTruncation ? theme.tree.branch : theme.tree.last;
				text += `\n ${theme.fg("dim", moreFilesBranch)} ${theme.fg(
					"muted",
					formatMoreItems(fileEntries.length - maxFiles, "file", theme),
				)}`;
			}
		}

		if (hasTruncation) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Find Renderer
// ============================================================================

interface FindArgs {
	pattern: string;
	path?: string;
	type?: string;
	hidden?: boolean;
	sortByMtime?: boolean;
	limit?: number;
}

const findRenderer: ToolRenderer<FindArgs, FindToolDetails> = {
	renderCall(args, theme) {
		const label = theme.fg("toolTitle", theme.bold("Find"));
		let text = `${label} ${theme.fg("accent", args.pattern || "*")}`;

		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.type && args.type !== "all") meta.push(`type:${args.type}`);
		if (args.hidden) meta.push("hidden");
		if (args.sortByMtime) meta.push("sort:mtime");
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		text += formatMeta(meta, theme);

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const label = "Find";
		const details = result.details;

		if (details?.error) {
			return renderErrorMessage(label, details.error, theme);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find((c) => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (!textContent || textContent.includes("No files matching") || textContent.trim() === "") {
				return renderEmptyMessage(label, "No files found", theme);
			}

			const lines = textContent.split("\n").filter((l) => l.trim());
			const maxLines = expanded ? lines.length : Math.min(lines.length, COLLAPSED_LIST_LIMIT);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			const hasMore = remaining > 0;

			const icon = theme.styledSymbol("status.success", "success");
			const summary = formatCount("file", lines.length);
			const expandHint = formatExpandHint(expanded, hasMore, theme);
			let text = `${icon} ${theme.fg("dim", summary)}${expandHint}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", displayLines[i])}`;
			}
			if (remaining > 0) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					formatMoreItems(remaining, "file", theme),
				)}`;
			}
			return new Text(text, 0, 0);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		if (fileCount === 0) {
			return renderEmptyMessage(label, "No files found", theme);
		}

		const icon = theme.styledSymbol("status.success", "success");
		const summaryText = formatCount("file", fileCount);
		const scopeLabel = formatScope(details?.scopePath, theme);
		const maxFiles = expanded ? files.length : Math.min(files.length, COLLAPSED_LIST_LIMIT);
		const hasMoreFiles = files.length > maxFiles;
		const expandHint = formatExpandHint(expanded, hasMoreFiles, theme);

		let text = `${icon} ${theme.fg("dim", summaryText)}${formatTruncationSuffix(
			truncated,
			theme,
		)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) {
			truncationReasons.push(`limit ${details.resultLimitReached} results`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}

		const hasTruncation = truncationReasons.length > 0;

		if (files.length > 0) {
			for (let i = 0; i < maxFiles; i++) {
				const isLast = i === maxFiles - 1 && !hasMoreFiles && !hasTruncation;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				const entry = files[i];
				const isDir = entry.endsWith("/");
				const entryPath = isDir ? entry.slice(0, -1) : entry;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? theme.fg("accent", theme.icon.folder)
					: theme.fg("muted", theme.getLangIcon(lang));
				text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg("accent", entry)}`;
			}

			if (hasMoreFiles) {
				const moreFilesBranch = hasTruncation ? theme.tree.branch : theme.tree.last;
				text += `\n ${theme.fg("dim", moreFilesBranch)} ${theme.fg(
					"muted",
					formatMoreItems(files.length - maxFiles, "file", theme),
				)}`;
			}
		}

		if (hasTruncation) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Notebook Renderer
// ============================================================================

interface NotebookArgs {
	action: string;
	notebookPath: string;
	cellNumber?: number;
	cellType?: string;
	content?: string;
}

function normalizeCellLines(lines: string[]): string[] {
	return lines.map((line) => (line.endsWith("\n") ? line.slice(0, -1) : line));
}

function renderCellPreview(lines: string[], expanded: boolean, theme: Theme): string {
	const normalized = normalizeCellLines(lines);
	if (normalized.length === 0) {
		return `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "(empty cell)")}`;
	}

	const maxLines = expanded ? normalized.length : Math.min(normalized.length, COLLAPSED_TEXT_LIMIT);
	let text = "";

	for (let i = 0; i < maxLines; i++) {
		const isLast = i === maxLines - 1 && (expanded || normalized.length <= maxLines);
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		const line = normalized[i];
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("toolOutput", line)}`;
	}

	const remaining = normalized.length - maxLines;
	if (remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line", theme))}`;
	}

	return text;
}

const notebookRenderer: ToolRenderer<NotebookArgs, NotebookToolDetails> = {
	renderCall(args, theme) {
		const label = theme.fg("toolTitle", theme.bold("Notebook"));
		let text = `${label} ${theme.fg("accent", args.action || "?")}`;

		const meta: string[] = [];
		meta.push(`in ${args.notebookPath || "?"}`);
		if (args.cellNumber !== undefined) meta.push(`cell:${args.cellNumber}`);
		if (args.cellType) meta.push(`type:${args.cellType}`);

		text += formatMeta(meta, theme);

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const label = "Notebook";
		const details = result.details;

		const content = result.content?.[0];
		if (content?.type === "text" && content.text?.startsWith("Error:")) {
			return renderErrorMessage(label, content.text, theme);
		}

		const action = details?.action ?? "edit";
		const cellIndex = details?.cellIndex;
		const cellType = details?.cellType;
		const totalCells = details?.totalCells;
		const cellSource = details?.cellSource;
		const lineCount = cellSource?.length;
		const canExpand = cellSource !== undefined && cellSource.length > COLLAPSED_TEXT_LIMIT;

		const icon = theme.styledSymbol("status.success", "success");
		const actionLabel = action === "insert" ? "Inserted" : action === "delete" ? "Deleted" : "Edited";
		const cellLabel = cellType || "cell";
		const summaryParts = [`${actionLabel} ${cellLabel} at index ${cellIndex ?? "?"}`];
		if (lineCount !== undefined) summaryParts.push(formatCount("line", lineCount));
		if (totalCells !== undefined) summaryParts.push(`${totalCells} total`);
		const summaryText = summaryParts.join(theme.sep.dot);

		const expandHint = formatExpandHint(expanded, canExpand, theme);
		let text = `${icon} ${theme.fg("dim", summaryText)}${expandHint}`;

		if (cellSource) {
			text += renderCellPreview(cellSource, expanded, theme);
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Ask Renderer
// ============================================================================

interface AskArgs {
	question: string;
	options?: Array<{ label: string }>;
	multi?: boolean;
}

const askRenderer: ToolRenderer<AskArgs, AskToolDetails> = {
	renderCall(args, theme) {
		if (!args.question) {
			return renderErrorMessage("Ask", "No question provided", theme);
		}

		const label = theme.fg("toolTitle", theme.bold("Ask"));
		let text = `${label} ${theme.fg("accent", args.question)}`;

		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		if (args.options?.length) meta.push(`options:${args.options.length}`);
		text += formatMeta(meta, theme);

		if (args.options?.length) {
			for (let i = 0; i < args.options.length; i++) {
				const opt = args.options[i];
				const isLast = i === args.options.length - 1;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg(
					"dim",
					theme.checkbox.unchecked,
				)} ${theme.fg("muted", opt.label)}`;
			}
		}

		return new Text(text, 0, 0);
	},

	renderResult(result, _opts, theme) {
		const { details } = result;
		if (!details) {
			const txt = result.content[0];
			return new Text(txt?.type === "text" && txt.text ? txt.text : "", 0, 0);
		}

		const hasSelection = details.customInput || details.selectedOptions.length > 0;
		const statusIcon = hasSelection
			? theme.styledSymbol("status.success", "success")
			: theme.styledSymbol("status.warning", "warning");

		let text = `${statusIcon} ${theme.fg("accent", details.question)}`;

		if (details.customInput) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.styledSymbol(
				"status.success",
				"success",
			)} ${theme.fg("toolOutput", details.customInput)}`;
		} else if (details.selectedOptions.length > 0) {
			const selected = details.selectedOptions;
			for (let i = 0; i < selected.length; i++) {
				const isLast = i === selected.length - 1;
				const branch = isLast ? theme.tree.last : theme.tree.branch;
				text += `\n ${theme.fg("dim", branch)} ${theme.fg(
					"success",
					theme.checkbox.checked,
				)} ${theme.fg("toolOutput", selected[i])}`;
			}
		} else {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.styledSymbol(
				"status.warning",
				"warning",
			)} ${theme.fg("warning", "Cancelled")}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Export
// ============================================================================

// ============================================================================
// LSP Renderer
// ============================================================================

interface LspArgs {
	action: string;
	file?: string;
	files?: string[];
	line?: number;
	column?: number;
}

const lspRenderer: ToolRenderer<LspArgs, LspToolDetails> = {
	renderCall: renderLspCall,
	renderResult: renderLspResult,
};

// ============================================================================
// Output Renderer
// ============================================================================

interface OutputArgs {
	ids: string[];
	format?: "raw" | "json" | "stripped";
	offset?: number;
	limit?: number;
}

type OutputEntry = OutputToolDetails["outputs"][number];

function formatOutputMeta(entry: OutputEntry, theme: Theme): string {
	const metaParts: string[] = [];
	if (entry.range) {
		metaParts.push(`lines ${entry.range.startLine}-${entry.range.endLine} of ${entry.range.totalLines}`);
	} else {
		metaParts.push(formatCount("line", entry.lineCount));
	}
	metaParts.push(formatBytes(entry.charCount));
	if (entry.provenance) {
		metaParts.push(`agent ${entry.provenance.agent}(${entry.provenance.index})`);
	}
	return theme.fg("dim", metaParts.join(theme.sep.dot));
}

const outputRenderer: ToolRenderer<OutputArgs, OutputToolDetails> = {
	renderCall(args, theme) {
		const ids = args.ids?.join(", ") ?? "?";
		const label = theme.fg("toolTitle", theme.bold("Output"));
		let text = `${label} ${theme.fg("accent", ids)}`;

		const meta: string[] = [];
		if (args.format && args.format !== "raw") meta.push(`format:${args.format}`);
		if (args.offset !== undefined) meta.push(`offset:${args.offset}`);
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);
		text += formatMeta(meta, theme);

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const label = "Output";
		const details = result.details;

		if (details?.notFound?.length) {
			const icon = theme.styledSymbol("status.error", "error");
			let text = `${icon} ${theme.fg("error", `Error: Not found: ${details.notFound.join(", ")}`)}`;
			if (details.availableIds?.length) {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					`Available: ${details.availableIds.join(", ")}`,
				)}`;
			} else {
				text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
					"muted",
					"No outputs available in current session",
				)}`;
			}
			return new Text(text, 0, 0);
		}

		const outputs = details?.outputs ?? [];

		if (outputs.length === 0) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			return renderEmptyMessage(label, textContent || "No outputs", theme);
		}

		const icon = theme.styledSymbol("status.success", "success");
		const summary = `read ${formatCount("output", outputs.length)}`;
		const previewLimit = expanded ? 3 : 1;
		const maxOutputs = expanded ? outputs.length : Math.min(outputs.length, 5);
		const hasMoreOutputs = outputs.length > maxOutputs;
		const hasMorePreview = outputs.some((o) => (o.previewLines?.length ?? 0) > previewLimit);
		const expandHint = formatExpandHint(expanded, hasMoreOutputs || hasMorePreview, theme);
		let text = `${icon} ${theme.fg("dim", summary)}${expandHint}`;

		for (let i = 0; i < maxOutputs; i++) {
			const o = outputs[i];
			const isLast = i === maxOutputs - 1 && !hasMoreOutputs;
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			text += `\n ${theme.fg("dim", branch)} ${theme.fg("accent", o.id)} ${formatOutputMeta(o, theme)}`;

			const previewLines = o.previewLines ?? [];
			const shownPreview = previewLines.slice(0, previewLimit);
			if (shownPreview.length > 0) {
				const childPrefix = isLast ? "   " : ` ${theme.fg("dim", theme.tree.vertical)} `;
				for (const line of shownPreview) {
					const previewText = truncate(line, TRUNCATE_LENGTHS.CONTENT, theme.format.ellipsis);
					text += `\n${childPrefix}${theme.fg("dim", theme.tree.hook)} ${theme.fg(
						"muted",
						"preview:",
					)} ${theme.fg("toolOutput", previewText)}`;
				}
			}
		}

		if (hasMoreOutputs) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"muted",
				formatMoreItems(outputs.length - maxOutputs, "output", theme),
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Task Renderer
// ============================================================================

const taskRenderer: ToolRenderer<any, TaskToolDetails> = {
	renderCall: renderTaskCall,
	renderResult: renderTaskResult,
};

// ============================================================================
// Ls Renderer
// ============================================================================

interface LsArgs {
	path?: string;
	limit?: number;
}

const lsRenderer: ToolRenderer<LsArgs, LsToolDetails> = {
	renderCall(args, theme) {
		const label = theme.fg("toolTitle", theme.bold("Ls"));
		let text = `${label} ${theme.fg("accent", args.path || ".")}`;

		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);
		text += formatMeta(meta, theme);

		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme) {
		const label = "Ls";
		const details = result.details;
		const textContent = result.content?.find((c) => c.type === "text")?.text ?? "";

		if (
			(!textContent || textContent.trim() === "" || textContent.trim() === "(empty directory)") &&
			(!details?.entries || details.entries.length === 0)
		) {
			return renderEmptyMessage(label, "Empty directory", theme);
		}

		let entries: string[] = details?.entries ? [...details.entries] : [];
		if (entries.length === 0) {
			const rawLines = textContent.split("\n").filter((l: string) => l.trim());
			entries = rawLines.filter((line) => !/^\[.*\]$/.test(line.trim()));
		}

		if (entries.length === 0) {
			return renderEmptyMessage(label, "Empty directory", theme);
		}

		let dirCount = details?.dirCount;
		let fileCount = details?.fileCount;
		if (dirCount === undefined || fileCount === undefined) {
			dirCount = 0;
			fileCount = 0;
			for (const entry of entries) {
				if (entry.endsWith("/")) {
					dirCount += 1;
				} else {
					fileCount += 1;
				}
			}
		}

		const truncated = Boolean(details?.truncation?.truncated || details?.entryLimitReached);
		const icon = truncated
			? theme.styledSymbol("status.warning", "warning")
			: theme.styledSymbol("status.success", "success");

		const summaryText = [formatCount("dir", dirCount ?? 0), formatCount("file", fileCount ?? 0)].join(theme.sep.dot);
		const maxEntries = expanded ? entries.length : Math.min(entries.length, COLLAPSED_LIST_LIMIT);
		const hasMoreEntries = entries.length > maxEntries;
		const expandHint = formatExpandHint(expanded, hasMoreEntries, theme);

		let text = `${icon} ${theme.fg("dim", summaryText)}${formatTruncationSuffix(truncated, theme)}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.entryLimitReached) {
			truncationReasons.push(`entry limit ${details.entryLimitReached}`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push(`output cap ${formatBytes(details.truncation.maxBytes)}`);
		}

		const hasTruncation = truncationReasons.length > 0;

		for (let i = 0; i < maxEntries; i++) {
			const entry = entries[i];
			const isLast = i === maxEntries - 1 && !hasMoreEntries && !hasTruncation;
			const branch = isLast ? theme.tree.last : theme.tree.branch;
			const isDir = entry.endsWith("/");
			const entryPath = isDir ? entry.slice(0, -1) : entry;
			const lang = isDir ? undefined : getLanguageFromPath(entryPath);
			const entryIcon = isDir ? theme.fg("accent", theme.icon.folder) : theme.fg("muted", theme.getLangIcon(lang));
			const entryColor = isDir ? "accent" : "toolOutput";
			text += `\n ${theme.fg("dim", branch)} ${entryIcon} ${theme.fg(entryColor, entry)}`;
		}

		if (hasMoreEntries) {
			const moreEntriesBranch = hasTruncation ? theme.tree.branch : theme.tree.last;
			text += `\n ${theme.fg("dim", moreEntriesBranch)} ${theme.fg(
				"muted",
				formatMoreItems(entries.length - maxEntries, "entry", theme),
			)}`;
		}

		if (hasTruncation) {
			text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};

// ============================================================================
// Web Fetch Renderer
// ============================================================================

interface WebFetchArgs {
	url: string;
	timeout?: number;
	raw?: boolean;
}

const webFetchRenderer: ToolRenderer<WebFetchArgs, WebFetchToolDetails> = {
	renderCall: renderWebFetchCall,
	renderResult: renderWebFetchResult,
};

// ============================================================================
// Web Search Renderer
// ============================================================================

interface WebSearchArgs {
	query: string;
	provider?: string;
	[key: string]: unknown;
}

const webSearchRenderer: ToolRenderer<WebSearchArgs, WebSearchRenderDetails> = {
	renderCall: renderWebSearchCall,
	renderResult: renderWebSearchResult,
};

// ============================================================================
// Export
// ============================================================================

export const toolRenderers: Record<
	string,
	{
		renderCall: (args: any, theme: Theme) => Component;
		renderResult: (result: any, options: RenderResultOptions, theme: Theme) => Component;
	}
> = {
	ask: askRenderer,
	grep: grepRenderer,
	find: findRenderer,
	notebook: notebookRenderer,
	ls: lsRenderer,
	lsp: lspRenderer,
	output: outputRenderer,
	task: taskRenderer,
	web_fetch: webFetchRenderer,
	web_search: webSearchRenderer,
};
