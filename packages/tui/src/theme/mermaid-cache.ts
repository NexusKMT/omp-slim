import type { MermaidRenderOptions } from "@oh-my-pi/pi-natives";
import { renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils/mermaid-ascii";

/**
 * Options controlling how fenced Mermaid source is resolved to terminal ASCII.
 * Extends the raw render options (theme, color mode, spacing, `useAscii`) with a
 * viewport-fitting hint.
 */
export interface MermaidResolveOptions extends MermaidRenderOptions {
	/**
	 * Maximum display width (terminal columns) the diagram should occupy.
	 * Flowcharts are also rendered top-down and left-to-right. A resize picks
	 * the shortest variant that fits; if none fit, the narrowest, which the
	 * caller may still clip. Omit to keep the source's own layout.
	 */
	maxWidth?: number;
}

// Memoizes rendered ASCII (and failures) keyed on the render options + the
// layout-direction variant + source. Width selection happens per call against
// the cached renders, so a terminal resize re-decides without re-rendering.
const cache = new Map<string, string | null>();

/** Display columns, ignoring ANSI so themed diagrams are measured as drawn. */
const DISPLAY_WIDTH = { countAnsiEscapeCodes: false } as const;

function asciiDisplayWidth(ascii: string): number {
	let max = 0;
	for (const line of ascii.split("\n")) {
		const width = Bun.stringWidth(line, DISPLAY_WIDTH);
		if (width > max) max = width;
	}
	return max;
}

interface LayoutCandidate {
	ascii: string;
	width: number;
	height: number;
	authored: boolean;
}

function measureLayout(ascii: string, authored: boolean): LayoutCandidate {
	return { ascii, width: asciiDisplayWidth(ascii), height: ascii.split("\n").length, authored };
}

function renderVariant(
	source: string,
	baseOptions: MermaidRenderOptions,
	baseKey: string,
	direction: "TD" | "LR" | null,
): string | null {
	const key = `${baseKey}\x00${direction ?? ""}\x00${source}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const ascii = renderMermaidAsciiSafe(source, direction ? { ...baseOptions, direction } : baseOptions);
	cache.set(key, ascii);
	return ascii;
}

/**
 * Resolve mermaid ASCII from fenced block source text.
 * Returns null when rendering fails, while memoizing failures to avoid repeated work.
 */
export function resolveMermaidAscii(source: string, options?: MermaidResolveOptions): string | null {
	const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
	if (!normalizedSource) return null;

	const { maxWidth, ...rest } = options ?? {};
	// Default to uncolored output; callers opt into a themed palette explicitly.
	const baseOptions: MermaidRenderOptions = { colorMode: "none", ...rest };
	const baseKey = JSON.stringify(baseOptions);

	const base = renderVariant(normalizedSource, baseOptions, baseKey, null);
	if (base === null) return null;
	if (maxWidth === undefined) return base;

	// Width selection is against cached renders, so a later resize re-decides
	// without drawing again. Forced TD/LR are no-ops for non-flowcharts.
	const candidates = [measureLayout(base, true)];
	for (const direction of ["TD", "LR"] as const) {
		const variant = renderVariant(normalizedSource, baseOptions, baseKey, direction);
		if (variant !== null) candidates.push(measureLayout(variant, false));
	}

	const fitting = candidates.filter(candidate => candidate.width <= maxWidth);
	const pool = fitting.length > 0 ? fitting : candidates;
	let best = pool[0]!;
	for (let i = 1; i < pool.length; i++) {
		const next = pool[i]!;
		if (fitting.length > 0) {
			if (next.height !== best.height) {
				if (next.height < best.height) best = next;
				continue;
			}
			if (next.authored !== best.authored) {
				if (next.authored) best = next;
				continue;
			}
			if (next.width < best.width) best = next;
			continue;
		}
		if (next.width !== best.width) {
			if (next.width < best.width) best = next;
			continue;
		}
		if (next.height !== best.height) {
			if (next.height < best.height) best = next;
			continue;
		}
		if (next.authored) best = next;
	}
	return best.ascii;
}

/**
 * Clear the mermaid cache.
 */
export function clearMermaidCache(): void {
	cache.clear();
}
