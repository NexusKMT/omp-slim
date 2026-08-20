import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ComposerShape } from "../../config/settings-schema";
import { theme } from "../theme/theme";

export interface ComposerShapePreviewOptions {
	requestRender?: () => void;
}

function fitLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

export function renderMockStatusLine(width: number): string {
	const sep = theme.fg("statusLineSep", ` ${theme.sep.powerlineThin} `);
	const leftContent = [
		theme.fg("statusLineModel", `${theme.icon.model} sonnet`),
		theme.fg("statusLinePath", "~/project"),
		theme.fg("statusLineGitDirty", `${theme.icon.git} main +2`),
	].join(sep);
	const rightContent = [
		theme.fg("statusLineContext", `${theme.icon.context} 42%`),
		theme.fg("statusLineCost", `${theme.icon.cost} 0.18`),
	].join(sep);
	const bgAnsi = theme.getBgAnsi("statusLineBg");
	const isTransparent = bgAnsi === "\x1b[49m" || !bgAnsi;
	const capAnsi = isTransparent ? "" : bgAnsi.replace("\x1b[48;", "\x1b[38;");
	const leftCap = isTransparent ? "" : `${capAnsi}${theme.sep.powerline}\x1b[39m`;
	const rightCap = isTransparent ? "" : `${capAnsi}${theme.sep.powerlineLeft}\x1b[39m`;
	const leftGroup = `${theme.bg("statusLineBg", ` ${leftContent} `)}${leftCap}`;
	const rightGroup = `${rightCap}${theme.bg("statusLineBg", ` ${rightContent} `)}`;
	const leftWidth = visibleWidth(leftGroup);
	const rightWidth = visibleWidth(rightGroup);
	const gapWidth = Math.max(1, width - leftWidth - rightWidth);
	const usedCount = Math.round(0.42 * gapWidth);
	const unusedCount = gapWidth - usedCount;
	const usedFill = usedCount > 0 ? theme.fg("borderAccent", theme.boxRound.horizontal.repeat(usedCount)) : "";
	const unusedFill = unusedCount > 0 ? theme.fg("border", theme.boxRound.horizontal.repeat(unusedCount)) : "";
	const gap = `\x1b[49m${usedFill}${unusedFill}\x1b[39m`;
	return `${leftGroup}${gap}${rightGroup}`;
}

export function renderComposerShapePreview(shape: ComposerShape, width: number): readonly string[] {
	const previewWidth = Math.max(24, Math.min(width, 76));
	const box = theme.boxRound;
	const innerWidth = Math.max(1, previewWidth - 2);
	const promptText = "Ask anything, edit files, run tools";

	switch (shape) {
		case "box": {
			const statusContent = renderMockStatusLine(innerWidth);
			const top = `${theme.fg("borderAccent", `${box.topLeft}${box.horizontal}`)} ${statusContent} ${theme.fg("borderAccent", `${box.horizontal}${box.topRight}`)}`;
			const bottomInner = `${promptText} `;
			const bottomFill = box.horizontal.repeat(Math.max(0, innerWidth - visibleWidth(bottomInner) - 2));
			const bottom = `${theme.fg("borderAccent", `${box.bottomLeft}${box.horizontal} `)}${theme.fg("text", promptText)}${theme.inverse(" ")}${theme.fg("borderAccent", ` ${bottomFill}${box.bottomRight}`)}`;
			return [top, bottom];
		}
		case "claude": {
			const rule = theme.fg("borderAccent", box.horizontal.repeat(previewWidth));
			const prompt = `${theme.fg("accent", "❯")} ${theme.fg("text", promptText)}${theme.inverse(" ")}`;
			return [rule, prompt, rule, renderMockStatusLine(previewWidth)];
		}
		case "pi": {
			const horizontal = box.horizontal.repeat(innerWidth);
			const top = theme.fg("borderAccent", `${box.topLeft}${horizontal}${box.topRight}`);
			const prompt = `${theme.fg("accent", ">")} ${theme.fg("text", promptText)}${theme.inverse(" ")}`;
			const content = `${theme.fg("borderAccent", box.vertical)} ${fitLine(prompt, innerWidth - 2)} ${theme.fg("borderAccent", box.vertical)}`;
			const bottom = theme.fg("borderAccent", `${box.bottomLeft}${horizontal}${box.bottomRight}`);
			return [top, content, bottom, renderMockStatusLine(previewWidth)];
		}
		case "borderless": {
			const prompt = `${theme.fg("accent", "❯")} ${theme.fg("text", promptText)}${theme.inverse(" ")}`;
			return [prompt, renderMockStatusLine(previewWidth)];
		}
	}
}

export class ComposerShapePreview implements Component {
	#shape: ComposerShape;
	#options: ComposerShapePreviewOptions;

	constructor(initialValue: ComposerShape = "box", options: ComposerShapePreviewOptions = {}) {
		this.#shape = initialValue;
		this.#options = options;
	}

	setValue(shape: ComposerShape): void {
		if (this.#shape === shape) return;
		this.#shape = shape;
		this.#options.requestRender?.();
	}

	render(width: number): readonly string[] {
		const lines = renderComposerShapePreview(this.#shape, width);
		return ["", theme.fg("muted", "Preview:"), ...lines];
	}
}
