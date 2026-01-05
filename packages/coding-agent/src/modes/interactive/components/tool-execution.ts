import * as os from "node:os";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import stripAnsi from "strip-ansi";
import type { CustomTool } from "../../../core/custom-tools/types";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff";
import { toolRenderers } from "../../../core/tools/renderers";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate";
import { sanitizeBinaryOutput } from "../../../utils/shell";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme";
import { renderDiff } from "./diff";
import { truncateToVisualLines } from "./visual-truncate";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
const LIST_PREVIEW_LINES = 15;
const GENERIC_PREVIEW_LINES = 6;
const GENERIC_ARG_PREVIEW = 6;
const GENERIC_VALUE_MAX = 80;
const EDIT_DIFF_PREVIEW_HUNKS = 2;
const EDIT_DIFF_PREVIEW_LINES = 24;

function wrapBrackets(text: string): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number, language: string): string {
	return theme.fg("dim", wrapBrackets(`Lines: ${lineCount}, Language: ${language}`));
}

type TreeListResult = {
	text: string;
	shown: number;
	total: number;
	remaining: number;
};

function buildTreeList(lines: string[], maxLines: number): TreeListResult {
	const total = lines.length;
	const shown = Math.min(total, maxLines);
	const remaining = total - shown;
	if (shown === 0) {
		return { text: "", shown, total, remaining };
	}

	const displayLines = lines.slice(0, shown);
	const hasMore = remaining > 0;
	const treeLines = displayLines.map((line, index) => {
		const isLast = index === displayLines.length - 1 && !hasMore;
		const connector = isLast ? theme.tree.last : theme.tree.branch;
		return `${theme.fg("dim", connector)} ${theme.fg("toolOutput", line)}`;
	});

	return { text: treeLines.join("\n"), shown, total, remaining };
}

function formatListSummary(label: string, total: number, shown: number, remaining: number, expanded: boolean): string {
	if (total === 0) return `0 ${label}`;
	if (expanded || remaining === 0) return `${total} ${label}`;
	return `showing ${shown} of ${total} ${label}`;
}

type DiffStats = {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
};

function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
): { text: string; hiddenHunks: number; hiddenLines: number } {
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);
	const kept: string[] = [];
	let inHunk = false;
	let currentHunks = 0;
	let reachedLimit = false;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		if (isChange && !inHunk) {
			currentHunks++;
			inHunk = true;
		}
		if (!isChange) {
			inHunk = false;
		}

		if (currentHunks > maxHunks) {
			reachedLimit = true;
			break;
		}

		kept.push(line);
		if (kept.length >= maxLines) {
			reachedLimit = true;
			break;
		}
	}

	if (!reachedLimit) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const keptStats = getDiffStats(kept.join("\n"));
	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptStats.hunks),
		hiddenLines: Math.max(0, totalStats.lines - kept.length),
	};
}

function formatDiagnostics(diag: { errored: boolean; summary: string; messages: string[] }, expanded: boolean): string {
	if (diag.messages.length === 0) return "";
	const icon = diag.errored
		? theme.styledSymbol("status.error", "error")
		: theme.styledSymbol("status.warning", "warning");
	let output = `\n\n${icon} ${theme.fg("toolTitle", "Diagnostics")} ${theme.fg("dim", `(${diag.summary})`)}`;
	const maxDiags = expanded ? diag.messages.length : 5;
	const displayDiags = diag.messages.slice(0, maxDiags);
	for (const d of displayDiags) {
		const color = d.includes("[error]") ? "error" : d.includes("[warning]") ? "warning" : "dim";
		output += `\n  ${theme.fg(color, d)}`;
	}
	if (diag.messages.length > maxDiags) {
		const remaining = diag.messages.length - maxDiags;
		output += theme.fg("dim", `\n  ${theme.format.ellipsis} (${remaining} more). Ctrl+O to expand diagnostics`);
	}
	return output;
}

function formatCompactValue(value: unknown, maxLength: number): string {
	let rendered = "";

	if (value === null) {
		rendered = "null";
	} else if (value === undefined) {
		rendered = "undefined";
	} else if (typeof value === "string") {
		rendered = value;
	} else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		rendered = String(value);
	} else if (Array.isArray(value)) {
		const previewItems = value.slice(0, 3).map((item) => formatCompactValue(item, maxLength));
		rendered = `[${previewItems.join(", ")}${value.length > 3 ? ", ..." : ""}]`;
	} else if (typeof value === "object") {
		try {
			rendered = JSON.stringify(value);
		} catch {
			rendered = "[object]";
		}
	} else if (typeof value === "function") {
		rendered = "[function]";
	} else {
		rendered = String(value);
	}

	if (rendered.length > maxLength) {
		rendered = `${rendered.slice(0, maxLength - 1)}${theme.format.ellipsis}`;
	}

	return rendered;
}

function formatArgsPreview(
	args: unknown,
	maxEntries: number,
	maxValueLength: number,
): { lines: string[]; remaining: number; total: number } {
	if (args === undefined) {
		return { lines: [theme.fg("dim", "(none)")], remaining: 0, total: 0 };
	}
	if (args === null || typeof args !== "object") {
		const single = theme.fg("toolOutput", formatCompactValue(args, maxValueLength));
		return { lines: [single], remaining: 0, total: 1 };
	}

	const entries = Object.entries(args as Record<string, unknown>);
	const total = entries.length;
	const visible = entries.slice(0, maxEntries);
	const lines = visible.map(([key, value]) => {
		const keyText = theme.fg("accent", key);
		const valueText = theme.fg("toolOutput", formatCompactValue(value, maxValueLength));
		return `${keyText}: ${valueText}`;
	});

	return { lines, remaining: Math.max(total - visible.length, 0), total };
}

/**
 * Convert absolute path to tilde notation if it's in home directory
 */
function shortenPath(path: string): string {
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private customTool?: CustomTool;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		customTool: CustomTool | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.customTool = customTool;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));

		// Use Box for custom tools, bash, or built-in tools that have renderers
		const hasRenderer = toolName in toolRenderers;
		if (customTool || toolName === "bash" || hasRenderer) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		// Set background based on state
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		// Check for custom tool rendering
		if (this.customTool) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (this.customTool.renderCall) {
				try {
					const callComponent = this.customTool.renderCall(this.args, theme);
					if (callComponent) {
						this.contentBox.addChild(callComponent);
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
			}

			// Render result component if we have a result
			if (this.result && this.customTool.renderResult) {
				try {
					const resultComponent = this.customTool.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
					);
					if (resultComponent) {
						this.contentBox.addChild(resultComponent);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
				}
			}
		} else if (this.toolName === "bash") {
			// Bash uses Box with visual line truncation
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();
			this.renderBashContent();
		} else if (this.toolName in toolRenderers) {
			// Built-in tools with custom renderers
			const renderer = toolRenderers[this.toolName];
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			try {
				const callComponent = renderer.renderCall(this.args, theme);
				if (callComponent) {
					this.contentBox.addChild(callComponent);
				}
			} catch {
				// Fall back to default on error
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
			}

			// Render result component if we have a result
			if (this.result) {
				try {
					const resultComponent = renderer.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
					);
					if (resultComponent) {
						this.contentBox.addChild(resultComponent);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			}
		} else {
			// Other built-in tools: use Text directly with caching
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
			const caps = getCapabilities();

			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						img.data,
						img.mimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts)
	 */
	private renderBashContent(): void {
		const command = this.args?.command || "";

		// Header
		this.contentBox.addChild(
			new Text(
				theme.fg("toolTitle", theme.bold(`$ ${command || theme.fg("toolOutput", theme.format.ellipsis)}`)),
				0,
				0,
			),
		);

		if (this.result) {
			const output = this.getTextOutput().trim();

			if (output) {
				// Style each line for the output
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					// Show all lines when expanded
					this.contentBox.addChild(new Text(`\n${styledOutput}`, 0, 0));
				} else {
					// Use visual line truncation when collapsed
					// Box has paddingX=1, so content width = terminal.columns - 2
					const { visualLines, skippedCount } = truncateToVisualLines(
						`\n${styledOutput}`,
						BASH_PREVIEW_LINES,
						this.ui.terminal.columns - 2,
					);

					const totalVisualLines = skippedCount + visualLines.length;
					if (skippedCount > 0) {
						this.contentBox.addChild(
							new Text(
								theme.fg(
									"dim",
									`\n${theme.format.ellipsis} (${skippedCount} earlier lines, showing ${visualLines.length} of ${totalVisualLines}) (ctrl+o to expand)`,
								),
								0,
								0,
							),
						);
					}

					// Add pre-rendered visual lines as a raw component
					this.contentBox.addChild({
						render: () => visualLines,
						invalidate: () => {},
					});
				}
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(
								truncation.maxBytes ?? DEFAULT_MAX_BYTES,
							)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(`\n${theme.fg("warning", wrapBrackets(warnings.join(". ")))}`, 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";

		if (this.toolName === "read") {
			const path = shortenPath(this.args?.file_path || this.args?.path || "");
			const offset = this.args?.offset;
			const limit = this.args?.limit;

			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

			if (this.result) {
				const output = this.getTextOutput();
				const rawPath = this.args?.file_path || this.args?.path || "";
				const lang = getLanguageFromPath(rawPath);
				const languageLabel = lang ?? "text";
				const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

				text += `\n${formatMetadataLine(countLines(output), languageLabel)}`;

				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += theme.fg(
						"toolOutput",
						`\n${theme.format.ellipsis} (${remaining} more lines) ${wrapBrackets("Ctrl+O to expand")}`,
					);
				}

				const truncation = this.result.details?.truncation;
				if (truncation?.truncated) {
					if (truncation.firstLineExceedsLimit) {
						text +=
							"\n" +
							theme.fg(
								"warning",
								wrapBrackets(
									`First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`,
								),
							);
					} else if (truncation.truncatedBy === "lines") {
						text +=
							"\n" +
							theme.fg(
								"warning",
								wrapBrackets(
									`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${
										truncation.maxLines ?? DEFAULT_MAX_LINES
									} line limit)`,
								),
							);
					} else {
						text +=
							"\n" +
							theme.fg(
								"warning",
								wrapBrackets(
									`Truncated: ${truncation.outputLines} lines shown (${formatSize(
										truncation.maxBytes ?? DEFAULT_MAX_BYTES,
									)} limit)`,
								),
							);
					}
				}
			}
		} else if (this.toolName === "write") {
			const rawPath = this.args?.file_path || this.args?.path || "";
			const path = shortenPath(rawPath);
			const fileContent = this.args?.content || "";
			const lang = getLanguageFromPath(rawPath);
			const lines = fileContent
				? lang
					? highlightCode(replaceTabs(fileContent), lang)
					: fileContent.split("\n")
				: [];
			const totalLines = lines.length;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis));

			text += `\n${formatMetadataLine(countLines(fileContent), lang ?? "text")}`;

			if (fileContent) {
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += theme.fg(
						"toolOutput",
						`\n${theme.format.ellipsis} (${remaining} more lines, ${totalLines} total) ${wrapBrackets("Ctrl+O to expand")}`,
					);
				}
			}

			// Show LSP diagnostics if available
			if (this.result?.details?.diagnostics) {
				text += formatDiagnostics(this.result.details.diagnostics, this.expanded);
			}
		} else if (this.toolName === "edit") {
			const rawPath = this.args?.file_path || this.args?.path || "";
			const path = shortenPath(rawPath);

			// Build path display, appending :line if we have diff info
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", theme.format.ellipsis);
			const firstChangedLine =
				(this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
					? this.editDiffPreview.firstChangedLine
					: undefined) ||
				(this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);
			if (firstChangedLine) {
				pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

			const editLanguage = getLanguageFromPath(rawPath) ?? "text";
			const editLineCount = countLines(this.args?.newText ?? this.args?.oldText ?? "");
			text += `\n${formatMetadataLine(editLineCount, editLanguage)}`;

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.editDiffPreview) {
				// Use cached diff preview (works both before and after execution)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					const diffStats = getDiffStats(this.editDiffPreview.diff);
					text += `\n${theme.fg(
						"dim",
						wrapBrackets(`Changes: +${diffStats.added} -${diffStats.removed}, ${diffStats.hunks} hunks`),
					)}`;

					const {
						text: diffText,
						hiddenHunks,
						hiddenLines,
					} = this.expanded
						? { text: this.editDiffPreview.diff, hiddenHunks: 0, hiddenLines: 0 }
						: truncateDiffByHunk(this.editDiffPreview.diff, EDIT_DIFF_PREVIEW_HUNKS, EDIT_DIFF_PREVIEW_LINES);

					text += `\n\n${renderDiff(diffText, { filePath: rawPath })}`;
					if (!this.expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
						const remainder: string[] = [];
						if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
						if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
						text += theme.fg(
							"toolOutput",
							`\n${theme.format.ellipsis} (${remainder.join(", ")}) ${wrapBrackets("Ctrl+O to expand")}`,
						);
					}
				}
			}

			// Show LSP diagnostics if available
			if (this.result?.details?.diagnostics) {
				text += formatDiagnostics(this.result.details.diagnostics, this.expanded);
			}
		} else if (this.toolName === "ls") {
			const path = shortenPath(this.args?.path || ".");
			const limit = this.args?.limit;

			text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : LIST_PREVIEW_LINES;
					const { text: treeText, shown, total, remaining } = buildTreeList(lines, maxLines);
					const summary = formatListSummary("entries", total, shown, remaining, this.expanded);
					const expandHint =
						!this.expanded && remaining > 0 ? theme.fg("dim", ` ${theme.nav.expand} Ctrl+O to expand`) : "";

					text += `\n\n${theme.fg("dim", wrapBrackets(summary))}${expandHint}`;
					if (treeText) {
						text += `\n${treeText}`;
					}
					if (!this.expanded && remaining > 0) {
						text += `\n${theme.fg("dim", theme.tree.last)} ${theme.fg(
							"toolOutput",
							`${theme.format.ellipsis} (${remaining} more)`,
						)}`;
					}
				} else {
					text += `\n\n${theme.fg("dim", wrapBrackets("0 entries"))}`;
				}

				const entryLimit = this.result.details?.entryLimitReached;
				const truncation = this.result.details?.truncation;
				if (entryLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (entryLimit) {
						warnings.push(
							typeof entryLimit === "number" ? `entry limit reached (${entryLimit})` : "entry limit reached",
						);
					}
					if (truncation?.truncated) {
						warnings.push(`output bytes limit (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)})`);
					}
					text += `\n${theme.fg("warning", wrapBrackets(`Truncated: ${warnings.join(", ")}`))}`;
				}
			}
		} else if (this.toolName === "find") {
			const pattern = this.args?.pattern || "";
			const path = shortenPath(this.args?.path || ".");
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				theme.fg("accent", pattern) +
				theme.fg("toolOutput", ` in ${path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : LIST_PREVIEW_LINES;
					const { text: treeText, shown, total, remaining } = buildTreeList(lines, maxLines);
					const summary = formatListSummary("results", total, shown, remaining, this.expanded);
					const expandHint =
						!this.expanded && remaining > 0 ? theme.fg("dim", ` ${theme.nav.expand} Ctrl+O to expand`) : "";

					text += `\n\n${theme.fg("dim", wrapBrackets(summary))}${expandHint}`;
					if (treeText) {
						text += `\n${treeText}`;
					}
					if (!this.expanded && remaining > 0) {
						text += `\n${theme.fg("dim", theme.tree.last)} ${theme.fg(
							"toolOutput",
							`${theme.format.ellipsis} (${remaining} more)`,
						)}`;
					}
				} else {
					text += `\n\n${theme.fg("dim", wrapBrackets("0 results"))}`;
				}

				const resultLimit = this.result.details?.resultLimitReached;
				const truncation = this.result.details?.truncation;
				if (resultLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (resultLimit) {
						warnings.push(
							typeof resultLimit === "number" ? `result limit reached (${resultLimit})` : "result limit reached",
						);
					}
					if (truncation?.truncated) {
						warnings.push(`output bytes limit (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)})`);
					}
					text += `\n${theme.fg("warning", wrapBrackets(`Truncated: ${warnings.join(", ")}`))}`;
				}
			}
		} else if (this.toolName === "grep") {
			const pattern = this.args?.pattern || "";
			const path = shortenPath(this.args?.path || ".");
			const glob = this.args?.glob;
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				theme.fg("accent", `/${pattern}/`) +
				theme.fg("toolOutput", ` in ${path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : LIST_PREVIEW_LINES;
					const { text: treeText, shown, total, remaining } = buildTreeList(lines, maxLines);
					const summary = formatListSummary("matches", total, shown, remaining, this.expanded);
					const expandHint =
						!this.expanded && remaining > 0 ? theme.fg("dim", ` ${theme.nav.expand} Ctrl+O to expand`) : "";

					text += `\n\n${theme.fg("dim", wrapBrackets(summary))}${expandHint}`;
					if (treeText) {
						text += `\n${treeText}`;
					}
					if (!this.expanded && remaining > 0) {
						text += `\n${theme.fg("dim", theme.tree.last)} ${theme.fg(
							"toolOutput",
							`${theme.format.ellipsis} (${remaining} more)`,
						)}`;
					}
				} else {
					text += `\n\n${theme.fg("dim", wrapBrackets("0 matches"))}`;
				}

				const matchLimit = this.result.details?.matchLimitReached;
				const truncation = this.result.details?.truncation;
				const linesTruncated = this.result.details?.linesTruncated;
				if (matchLimit || truncation?.truncated || linesTruncated) {
					const warnings: string[] = [];
					if (matchLimit) {
						warnings.push(
							typeof matchLimit === "number" ? `match limit reached (${matchLimit})` : "match limit reached",
						);
					}
					if (truncation?.truncated) {
						warnings.push(`output bytes limit (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)})`);
					}
					if (linesTruncated) {
						warnings.push("line length truncated");
					}
					text += `\n${theme.fg("warning", wrapBrackets(`Truncated: ${warnings.join(", ")}`))}`;
				}
			}
		} else {
			// Generic tool (shouldn't reach here for custom tools)
			text = theme.fg("toolTitle", theme.bold(this.toolName));

			const argTotal =
				this.args && typeof this.args === "object"
					? Object.keys(this.args as Record<string, unknown>).length
					: this.args === undefined
						? 0
						: 1;
			const argPreviewLimit = this.expanded ? argTotal : GENERIC_ARG_PREVIEW;
			const valueLimit = this.expanded ? 2000 : GENERIC_VALUE_MAX;
			const argsPreview = formatArgsPreview(this.args, argPreviewLimit, valueLimit);

			text += `\n\n${theme.fg("toolTitle", "Args")} ${theme.fg("dim", `(${argsPreview.total})`)}`;
			if (argsPreview.lines.length > 0) {
				text += `\n${argsPreview.lines.join("\n")}`;
			} else {
				text += `\n${theme.fg("dim", "(none)")}`;
			}
			if (argsPreview.remaining > 0) {
				text += theme.fg(
					"dim",
					`\n${theme.format.ellipsis} (${argsPreview.remaining} more args) (ctrl+o to expand)`,
				);
			}

			const output = this.getTextOutput().trim();
			text += `\n\n${theme.fg("toolTitle", "Output")}`;
			if (output) {
				const lines = output.split("\n");
				const maxLines = this.expanded ? lines.length : GENERIC_PREVIEW_LINES;
				const displayLines = lines.slice(-maxLines);
				const remaining = lines.length - displayLines.length;
				text += ` ${theme.fg("dim", `(${lines.length} lines)`)}`;
				text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (remaining > 0) {
					text += theme.fg("dim", `\n${theme.format.ellipsis} (${remaining} earlier lines) (ctrl+o to expand)`);
				}
			} else {
				text += ` ${theme.fg("dim", "(empty)")}`;
			}
		}

		return text;
	}
}
