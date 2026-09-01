/**
 * Fullscreen esc-esc rewind selector.
 *
 * Replays the current session's branch with {@link ChatTranscriptBuilder} on
 * the alternate screen (`ui.showOverlay(..., { fullscreen: true })`) and moves
 * a dotted outline over the rendered transcript block the rewind would land
 * on, instead of listing user messages in a detached picker. Entries that
 * render nothing (notices, hidden custom messages, tool results folded into
 * their call cards) are never outlined: results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output, and the rest
 * are skipped entirely.
 *
 * When the outlined turn has sibling branches in the session tree, the region
 * below the divergence renders as a horizontal strip of half-width columns —
 * the current path first, each alternate branch beside it — and Left/Right
 * slide between them with an eased camera animation. Sibling columns are
 * fully rendered transcripts of that branch's most-recent path, built lazily
 * and cached per divergence.
 *
 * Keys: Up/Down step through rendered items in transcript order (within the
 * active column when a strip is open), Left/Right slide between branch
 * variants at a fork and jump between user turns elsewhere, Enter rewinds to
 * the outlined item, Esc cancels.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { SessionMessageEntry } from "../../session/session-entries";
import { theme } from "../theme/theme";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { fit } from "./overlay-box";
import { isUsageRowBlock } from "./usage-row";

/** One alternate branch at a divergence: its root and message path root → most-recent leaf. */
export interface BranchVariantPath {
	rootId: string;
	entries: SessionMessageEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	/** Sibling branch paths of `entryId`'s turn (excluding the turn itself). */
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	/** Rewind the session to `entryId` (a message entry anywhere in the tree). */
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

/** One selectable rewind point: a message entry plus its rendered block range. */
interface RewindTarget {
	/** Entry the rewind lands on; extended over trailing componentless tool results. */
	entryId: string;
	/** Entry that opened this turn (pre-fold) — the anchor for sibling-branch lookup. */
	turnId: string;
	/** Real user prompt — the Left/Right jump set and the branch-and-redraft flow. */
	isUserTurn: boolean;
	/** First transcript-container child rendered by this entry. */
	start: number;
	/** One past the last child rendered by this entry. */
	end: number;
}

/** Lazily built transcript column for one alternate branch. */
interface SiblingColumn {
	rootId: string;
	builder: ChatTranscriptBuilder;
	targets: RewindTarget[];
	/** Short label for the column header: the branch's first user prompt. */
	label: string;
}

/** Composed rows of one column plus the outline's line range within them. */
interface ComposedColumn {
	lines: string[];
	selStart: number;
	selEnd: number;
}

/** Rows the frame chrome occupies: top rule, header, rule, footer hint, bottom rule. */
const CHROME_ROWS = 5;
/** Blank columns between branch-strip columns. */
const STRIP_GAP = 2;
/** Duration of the branch-swap camera slide. */
const SLIDE_MS = 160;

// User bubbles wrap their rows in OSC 133 prompt-zone marks (see
// user-message.ts). Re-emitting those inside the alternate-screen overlay
// latches the terminal's prompt semantics onto overlay rows and garbles the
// frame, so embedded rows shed them; the transcript proper keeps its zones.
const OSC133_SPAN_REGEX = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Copy-on-write removal of OSC 133 spans from a rendered row array. */
function stripPromptZones(rows: readonly string[]): readonly string[] {
	let sanitized: string[] | undefined;
	for (let index = 0; index < rows.length; index++) {
		if (!rows[index]!.includes("\x1b]133;")) continue;
		sanitized ??= rows.slice();
		sanitized[index] = rows[index]!.replace(OSC133_SPAN_REGEX, "");
	}
	return sanitized ?? rows;
}

export class RewindSelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#border = new DynamicBorder();
	#targets: RewindTarget[] = [];
	#selected = 0;
	/** Per-main-target "renders at least one non-blank row", refreshed each frame. */
	#mainVisible: boolean[] | undefined;
	/** Same, for the active sibling column. */
	#siblingVisible: boolean[] | undefined;
	#scrollToSelection = true;
	#expanded = false;

	// Branch strip: present when the selected turn has sibling branches.
	// Column 0 is the current path; siblings follow in tree order.
	#variantCache = new Map<string, SiblingColumn[]>();
	/** 0 = current path column; 1..n = sibling column index + 1. */
	#activeVariant = 0;
	/** Selected target within the active sibling column. */
	#siblingSelected = 0;
	/** Camera slide between variant positions (fractional column index). */
	#slide: { from: number; to: number; startedAt: number } | undefined;
	#slideTimer: NodeJS.Timeout | undefined;

	constructor(
		entries: SessionMessageEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#builder = this.#newBuilder();
		this.#targets = this.#appendEntries(this.#builder, entries);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
	}

	/** Number of selectable rewind points on the current path; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	#newBuilder(): ChatTranscriptBuilder {
		return new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			requestRender: this.deps.requestRender,
		});
	}

	/** Append `entries` to `builder`, returning the selectable targets they produce. */
	#appendEntries(builder: ChatTranscriptBuilder, entries: SessionMessageEntry[]): RewindTarget[] {
		const targets: RewindTarget[] = [];
		for (const entry of entries) {
			const children = builder.container.children;
			const before = children.length;
			builder.append([entry]);
			const after = children.length;
			let start = before;
			// A usage row flushed at the head of this append reports the previous
			// turn's metrics — attribute it to the previous target's outline.
			while (start < after && isUsageRowBlock(children[start]!)) {
				const previous = targets.at(-1);
				if (previous && previous.end === start) previous.end = start + 1;
				start++;
			}
			if (start >= after) {
				// Rendered nothing of its own. A tool result folds into the turn
				// that rendered its call card, so rewinding that turn keeps the
				// result; anything else (notices, hidden messages) is skipped.
				const previous = targets.at(-1);
				if (entry.message.role === "toolResult" && previous) previous.entryId = entry.id;
				continue;
			}
			targets.push({
				entryId: entry.id,
				turnId: entry.id,
				isUserTurn: entry.message.role === "user" && userMessageHasText(entry.message),
				start,
				end: after,
			});
		}
		return targets;
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.container.invalidate();
		}
	}

	dispose(): void {
		this.#stopSlide();
		this.#builder.dispose();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.dispose();
		}
		this.#variantCache.clear();
	}

	// ========================================================================
	// Branch strip
	// ========================================================================

	/** Sibling columns for the selected turn, built lazily and cached per divergence. */
	#stripColumns(): SiblingColumn[] {
		const target = this.#targets[this.#selected];
		if (!target || !this.deps.siblingPaths) return [];
		const cached = this.#variantCache.get(target.turnId);
		if (cached) return cached;
		const columns: SiblingColumn[] = [];
		for (const sibling of this.deps.siblingPaths(target.turnId)) {
			if (sibling.entries.length === 0) continue;
			const builder = this.#newBuilder();
			builder.setExpanded(this.#expanded);
			const targets = this.#appendEntries(builder, sibling.entries);
			const firstUser = sibling.entries.find(
				entry => entry.message.role === "user" && userMessageHasText(entry.message),
			);
			const label =
				firstUser && firstUser.message.role === "user" ? userMessageText(firstUser.message) : sibling.rootId;
			columns.push({ rootId: sibling.rootId, builder, targets, label });
		}
		this.#variantCache.set(target.turnId, columns);
		return columns;
	}

	/** The target the dotted outline currently rests on. */
	#outlinedTarget(): RewindTarget | undefined {
		if (this.#activeVariant > 0) {
			return this.#stripColumns()[this.#activeVariant - 1]?.targets[this.#siblingSelected];
		}
		return this.#targets[this.#selected];
	}

	#slideTo(variant: number): void {
		const now = Date.now();
		const from = this.#slidePosition(now);
		this.#slide = { from, to: variant, startedAt: now };
		this.#activeVariant = variant;
		this.#scrollToSelection = true;
		this.#slideTimer ??= setInterval(() => {
			if (!this.#slide || Date.now() - this.#slide.startedAt >= SLIDE_MS) this.#stopSlide();
			this.deps.requestRender();
		}, 16);
		this.deps.requestRender();
	}

	#stopSlide(): void {
		this.#slide = undefined;
		if (this.#slideTimer !== undefined) {
			clearInterval(this.#slideTimer);
			this.#slideTimer = undefined;
		}
	}

	/** Fractional variant position of the camera at `now` (eased). */
	#slidePosition(now: number): number {
		if (!this.#slide) return this.#activeVariant;
		const t = Math.min(1, (now - this.#slide.startedAt) / SLIDE_MS);
		const eased = 1 - (1 - t) ** 3;
		return this.#slide.from + (this.#slide.to - this.#slide.from) * eased;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.deps.onCancel();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#expanded = !this.#expanded;
			this.#builder.setExpanded(this.#expanded);
			for (const columns of this.#variantCache.values()) {
				for (const column of columns) column.builder.setExpanded(this.#expanded);
			}
			this.deps.requestRender();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
			else this.#move(-1, target => target.isUserTurn);
			return;
		}
		if (matchesKey(data, "right")) {
			const columns = this.#stripColumns();
			if (this.#activeVariant < columns.length) {
				this.#siblingSelected = 0;
				this.#slideTo(this.#activeVariant + 1);
			} else if (this.#activeVariant === 0) {
				this.#move(1, target => target.isUserTurn);
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const target = this.#outlinedTarget();
			if (target) this.deps.onSelect(target.entryId);
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#scrollView.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** Up/Down: step within the active column; leaving a sibling column's top exits the strip. */
	#moveVertical(delta: -1 | 1): void {
		if (this.#activeVariant > 0) {
			const targets = this.#stripColumns()[this.#activeVariant - 1]?.targets ?? [];
			let index = this.#siblingSelected + delta;
			while (index >= 0 && index < targets.length && this.#siblingVisible?.[index] === false) index += delta;
			if (index >= 0 && index < targets.length) {
				this.#siblingSelected = index;
				this.#scrollToSelection = true;
				this.deps.requestRender();
			} else if (delta === -1) {
				// Off the top of an alternate: return to the current path above the fork.
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.#move(-1, () => true);
			}
			return;
		}
		this.#move(delta, () => true);
	}

	/** Step the main selection by `delta` to the nearest visible target passing `accept`. */
	#move(delta: -1 | 1, accept: (target: RewindTarget) => boolean): void {
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#isMainSelectable(index) && accept(this.#targets[index]!)) {
				this.#selected = index;
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.#scrollToSelection = true;
				this.deps.requestRender();
				return;
			}
			index += delta;
		}
	}

	#isMainSelectable(index: number): boolean {
		return this.#mainVisible?.[index] ?? true;
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// ScrollView reserves the last column for the scrollbar; the outline
		// consumes two columns each side ("┆ " / " ┆"), unselected rows a
		// matching two-column left gutter so blocks never shift while stepping.
		const contentWidth = Math.max(1, width - 1);
		const children = this.#builder.container.children;
		const mainInner = Math.max(10, contentWidth - 4);
		const childRows = children.map(child => stripPromptZones(child.render(mainInner)));

		this.#mainVisible = this.#targets.map(target => {
			for (let index = target.start; index < target.end; index++) {
				if (childRows[index]!.some(row => /\S/.test(row))) return true;
			}
			return false;
		});
		if (!this.#isMainSelectable(this.#selected)) {
			// The current target collapsed (e.g. expansion toggle): rest on the
			// nearest visible one above, falling back to the nearest below.
			let above = this.#selected - 1;
			while (above >= 0 && !this.#isMainSelectable(above)) above--;
			let below = this.#selected + 1;
			while (below < this.#targets.length && !this.#isMainSelectable(below)) below++;
			if (above >= 0) this.#selected = above;
			else if (below < this.#targets.length) this.#selected = below;
			this.#activeVariant = 0;
			this.#siblingSelected = 0;
		}

		const columns = this.#stripColumns();
		const composed =
			columns.length > 0
				? this.#renderStrip(childRows, columns, contentWidth)
				: this.#composeColumn(
						childRows,
						0,
						children.length,
						this.#targets,
						this.#selected,
						contentWidth,
						undefined,
					);
		const lines = composed.lines;

		const viewportHeight = Math.max(3, termHeight - CHROME_ROWS);
		this.#scrollView.setLines(lines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#scrollToSelection && composed.selStart >= 0) {
			const offset = this.#scrollView.getScrollOffset();
			const top = Math.max(0, composed.selStart - 1);
			const bottom = Math.min(lines.length, composed.selEnd + 1);
			if (top < offset) this.#scrollView.setScrollOffset(top);
			else if (bottom > offset + viewportHeight) this.#scrollView.setScrollOffset(bottom - viewportHeight);
			this.#scrollToSelection = false;
		}

		const output: string[] = [];
		output.push(...this.#border.render(width));
		output.push(
			` ${theme.icon.rewind} ${theme.bold("Rewind")}${theme.sep.dot}${theme.fg("dim", "pick the point to continue from")}`,
		);
		output.push(...this.#border.render(width));
		output.push(...this.#scrollView.render(width));
		const position = this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : "";
		const lateral = columns.length > 0 ? "←/→ branches" : "←/→ user turns";
		output.push(` ${theme.fg("dim", `${position}↑/↓ step  ${lateral}  enter rewind  ctrl+o expand  esc cancel`)}`);
		output.push(...this.#border.render(width));
		return output;
	}

	/**
	 * Compose one column: gutter-prefixed rows for `childRows[from, to)` with a
	 * dotted outline around `targets[selected]`. `header` rows, when given,
	 * lead the column (branch strip captions).
	 */
	#composeColumn(
		childRows: (readonly string[])[],
		from: number,
		to: number,
		targets: readonly RewindTarget[],
		selected: number,
		columnWidth: number,
		header: string[] | undefined,
	): ComposedColumn {
		const inner = Math.max(10, columnWidth - 4);
		const lines: string[] = header ? [...header] : [];
		let selStart = -1;
		let selEnd = -1;
		const target = selected >= 0 ? targets[selected] : undefined;
		for (let index = from; index < to; index++) {
			if (target && index === target.start && target.end <= to) {
				const segment: string[] = [];
				for (let child = target.start; child < target.end; child++) segment.push(...childRows[child]!);
				// Outline only the non-blank core; edge spacers stay outside.
				let head = 0;
				let tail = segment.length;
				while (head < tail && !/\S/.test(segment[head]!)) head++;
				while (tail > head && !/\S/.test(segment[tail - 1]!)) tail--;
				for (let row = 0; row < head; row++) lines.push("");
				selStart = lines.length;
				lines.push(this.#outlineRule(theme.boxRound.topLeft, theme.boxRound.topRight, inner));
				const vertical = theme.fg("accent", theme.boxDotted.vertical);
				for (let row = head; row < tail; row++) {
					lines.push(`${vertical} ${fit(segment[row]!, inner)} ${vertical}`);
				}
				lines.push(this.#outlineRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, inner));
				selEnd = lines.length;
				for (let row = tail; row < segment.length; row++) lines.push("");
				index = target.end - 1;
				continue;
			}
			for (const row of childRows[index]!) lines.push(row ? `  ${row}` : row);
		}
		return { lines, selStart, selEnd };
	}

	/**
	 * Shared prefix at full width, then the divergence as a camera-positioned
	 * strip of half-width branch columns (current path first, siblings after).
	 */
	#renderStrip(mainRows: (readonly string[])[], columns: SiblingColumn[], contentWidth: number): ComposedColumn {
		const anchor = this.#targets[this.#selected]!;
		const colWidth = Math.max(24, Math.floor((contentWidth - STRIP_GAP) / 2));
		const colInner = Math.max(10, colWidth - 4);
		const count = columns.length + 1;

		// Shared history above the fork, full width, never outlined.
		const prefix = this.#composeColumn(mainRows, 0, anchor.start, [], -1, contentWidth, undefined);

		// Column 0: the current path from the fork down, re-rendered at column width.
		const suffixRows: (readonly string[])[] = [];
		for (let index = anchor.start; index < this.#builder.container.children.length; index++) {
			suffixRows.push(stripPromptZones(this.#builder.container.children[index]!.render(colInner)));
		}
		const suffixTargets = this.#targets.slice(this.#selected).map(target => ({
			...target,
			start: target.start - anchor.start,
			end: target.end - anchor.start,
		}));
		const composedColumns: ComposedColumn[] = [
			this.#composeColumn(
				suffixRows,
				0,
				suffixRows.length,
				suffixTargets,
				this.#activeVariant === 0 ? 0 : -1,
				colWidth,
				this.#columnHeader(0, count, "current", colWidth),
			),
		];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const rows = column.builder.container.children.map(child => stripPromptZones(child.render(colInner)));
			if (this.#activeVariant === index + 1) {
				this.#siblingVisible = column.targets.map(target => {
					for (let child = target.start; child < target.end; child++) {
						if (rows[child]!.some(row => /\S/.test(row))) return true;
					}
					return false;
				});
			}
			composedColumns.push(
				this.#composeColumn(
					rows,
					0,
					rows.length,
					column.targets,
					this.#activeVariant === index + 1 ? this.#siblingSelected : -1,
					colWidth,
					this.#columnHeader(index + 1, count, column.label, colWidth),
				),
			);
		}

		// Camera over the strip: keep the active (possibly mid-slide) column centered.
		const stride = colWidth + STRIP_GAP;
		const totalWidth = count * colWidth + (count - 1) * STRIP_GAP;
		const cameraAt = (position: number) =>
			Math.max(
				0,
				Math.min(position * stride - (contentWidth - colWidth) / 2, Math.max(0, totalWidth - contentWidth)),
			);
		const position = this.#slidePosition(Date.now());
		const camera = cameraAt(position);

		const height = Math.max(...composedColumns.map(column => column.lines.length));
		const lines = prefix.lines;
		// With more branches than the window fits, a dot rail tracks the active
		// column and dim ellipses flag content beyond the visible edge.
		if (count > 2) {
			const dots: string[] = [];
			for (let index = 0; index < count; index++) {
				dots.push(
					index === this.#activeVariant
						? theme.fg("accent", theme.radio.selected)
						: theme.fg("dim", theme.radio.unselected),
				);
			}
			// Edge markers follow the slide's destination, not the eased camera,
			// so they flip in step with the dot rail.
			const settled = cameraAt(this.#activeVariant);
			const moreLeft = settled > 0.5 ? theme.fg("dim", "… ") : "  ";
			const moreRight = settled + contentWidth < totalWidth - 0.5 ? theme.fg("dim", " …") : "";
			const rail = `${moreLeft}${dots.join(" ")}${moreRight}`;
			const pad = Math.max(0, Math.floor((contentWidth - visibleWidth(rail)) / 2));
			lines.push(padding(pad) + rail, "");
		}
		const active = composedColumns[this.#activeVariant]!;
		const selStart = active.selStart >= 0 ? lines.length + active.selStart : -1;
		const selEnd = active.selEnd >= 0 ? lines.length + active.selEnd : -1;
		for (let row = 0; row < height; row++) {
			let line = "";
			let filled = 0;
			for (let index = 0; index < count; index++) {
				const x0 = index * stride - camera;
				const x1 = x0 + colWidth;
				const visible0 = Math.max(0, x0);
				const visible1 = Math.min(contentWidth, x1);
				if (visible1 <= visible0) continue;
				const source = fit(composedColumns[index]!.lines[row] ?? "", colWidth);
				const slice = sliceByColumn(source, visible0 - x0, visible1 - visible0, true);
				line += padding(Math.max(0, visible0 - filled)) + fit(slice, visible1 - visible0);
				filled = visible1;
			}
			lines.push(line);
		}
		return { lines, selStart, selEnd };
	}

	/** Two caption rows leading a strip column: `⎇ i/n · label` plus a spacer. */
	#columnHeader(index: number, count: number, label: string, columnWidth: number): string[] {
		const caption = truncateToWidth(
			`${theme.icon.branch} ${index + 1}/${count} ${theme.sep.dot} ${label}`,
			columnWidth - 2,
		);
		const active = index === this.#activeVariant;
		return [` ${theme.fg(active ? "accent" : "dim", caption)}`, ""];
	}

	/** Dotted horizontal rule with rounded corners, spanning the outline width. */
	#outlineRule(left: string, right: string, innerWidth: number): string {
		return theme.fg("accent", left + theme.boxDotted.horizontal.repeat(innerWidth + 2) + right);
	}
}

/** Plain text of a user message (string or text blocks), single line. */
function userMessageText(message: Extract<SessionMessageEntry["message"], { role: "user" }>): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map(block => block.text)
					.join(" ");
	return text.replace(/\s+/g, " ").trim();
}

/** Whether a user message carries prompt text (string or text blocks). */
function userMessageHasText(message: SessionMessageEntry["message"]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.trim().length > 0;
	return message.content.some(block => block.type === "text" && block.text.trim().length > 0);
}
