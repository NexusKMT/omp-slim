/**
 * Shared utilities and constants for tool renderers.
 *
 * Provides consistent formatting, truncation, and display patterns across all
 * tool renderers to ensure a unified TUI experience.
 */

import type { Theme } from "../../modes/interactive/theme/theme";

// =============================================================================
// Standardized Display Constants
// =============================================================================

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
} as const;

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
} as const;

/** Standard expand hint text */
export const EXPAND_HINT = "(Ctrl+O to expand)";

// =============================================================================
// Text Truncation Utilities
// =============================================================================

/**
 * Truncate text to max length with ellipsis.
 * The most commonly duplicated utility across renderers.
 */
export function truncate(text: string, maxLen: number, ellipsis: string): string {
	if (text.length <= maxLen) return text;
	const sliceLen = Math.max(0, maxLen - ellipsis.length);
	return `${text.slice(0, sliceLen)}${ellipsis}`;
}

/**
 * Get first N lines of text as preview, with each line truncated.
 */
export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis: string): string[] {
	const lines = text.split("\n").filter((l) => l.trim());
	return lines.slice(0, maxLines).map((l) => truncate(l.trim(), maxLineLen, ellipsis));
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Extract domain from URL, stripping www. prefix.
 */
export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Format byte count for display (e.g., "1.5KB", "2.3MB").
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format token count for display (e.g., "1.5k", "25k").
 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return String(tokens);
}

/**
 * Format duration for display (e.g., "500ms", "2.5s", "1.2m").
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format count with pluralized label (e.g., "3 files", "1 error").
 */
export function formatCount(label: string, count: number): string {
	const safeCount = Number.isFinite(count) ? count : 0;
	return `${safeCount} ${pluralize(label, safeCount)}`;
}

/**
 * Format age from seconds to human-readable string.
 */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}

// =============================================================================
// Theme Helper Utilities
// =============================================================================

/**
 * Get the appropriate status icon with color for a given state.
 * Standardizes status icon usage across all renderers.
 */
export function getStyledStatusIcon(
	status: "success" | "error" | "warning" | "info" | "pending" | "running" | "aborted",
	theme: Theme,
	spinnerFrame?: number,
): string {
	switch (status) {
		case "success":
			return theme.styledSymbol("status.success", "success");
		case "error":
			return theme.styledSymbol("status.error", "error");
		case "warning":
			return theme.styledSymbol("status.warning", "warning");
		case "info":
			return theme.styledSymbol("status.info", "accent");
		case "pending":
			return theme.styledSymbol("status.pending", "muted");
		case "running":
			if (spinnerFrame !== undefined) {
				const frames = theme.spinnerFrames;
				return frames[spinnerFrame % frames.length];
			}
			return theme.styledSymbol("status.running", "accent");
		case "aborted":
			return theme.styledSymbol("status.aborted", "error");
	}
}

/**
 * Format the expand hint with proper theming.
 * Returns empty string if already expanded or there is nothing more to show.
 */
export function formatExpandHint(expanded: boolean, hasMore: boolean, theme: Theme): string {
	return !expanded && hasMore ? theme.fg("dim", ` ${EXPAND_HINT}`) : "";
}

/**
 * Format a badge like [done] or [failed] with brackets and color.
 */
export function formatBadge(
	label: string,
	color: "success" | "error" | "warning" | "accent" | "muted",
	theme: Theme,
): string {
	const left = theme.format.bracketLeft;
	const right = theme.format.bracketRight;
	return theme.fg(color, `${left}${label}${right}`);
}

/**
 * Build a "more items" suffix line for truncated lists.
 * Uses consistent wording pattern.
 */
export function formatMoreItems(remaining: number, itemType: string, theme: Theme): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `${theme.format.ellipsis} ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	if (/(?:ch|sh|s|x|z)$/i.test(label)) return `${label}es`;
	if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
	return `${label}s`;
}

// =============================================================================
// Tree Rendering Utilities
// =============================================================================

/**
 * Get the branch character for a tree item.
 */
export function getTreeBranch(isLast: boolean, theme: Theme): string {
	return isLast ? theme.tree.last : theme.tree.branch;
}

/**
 * Get the continuation prefix for nested content under a tree item.
 */
export function getTreeContinuePrefix(isLast: boolean, theme: Theme): string {
	return isLast ? "   " : `${theme.tree.vertical}  `;
}

/**
 * Render a list of items with tree branches, handling truncation.
 *
 * @param items - Full list of items to render
 * @param expanded - Whether view is expanded
 * @param maxCollapsed - Max items to show when collapsed
 * @param renderItem - Function to render a single item
 * @param itemType - Type name for "more X" message (e.g., "file", "entry")
 * @param theme - Theme instance
 * @returns Array of formatted lines
 */
export function renderTreeList<T>(
	items: T[],
	expanded: boolean,
	maxCollapsed: number,
	renderItem: (item: T, branch: string, isLast: boolean, theme: Theme) => string,
	itemType: string,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const maxItems = expanded ? items.length : Math.min(items.length, maxCollapsed);

	for (let i = 0; i < maxItems; i++) {
		const isLast = i === maxItems - 1 && (expanded || items.length <= maxCollapsed);
		const branch = getTreeBranch(isLast, theme);
		lines.push(renderItem(items[i], branch, isLast, theme));
	}

	if (!expanded && items.length > maxCollapsed) {
		const remaining = items.length - maxCollapsed;
		lines.push(
			` ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, itemType, theme))}`,
		);
	}

	return lines;
}
