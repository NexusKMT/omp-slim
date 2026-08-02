import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine } from "../tui";
import type { ComputerToolDetails } from "./computer";
import { PREVIEW_LIMITS, replaceTabs, truncateToWidth } from "./render-utils";

interface ComputerRenderArgs {
	window?: unknown;
	actions?: Array<{ type?: unknown }>;
}

interface ComputerRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function clean(value: unknown, width = 100): string {
	const text = typeof value === "string" ? value : JSON.stringify(value) || String(value);
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " "), width);
}

function isComputerToolDetails(value: unknown): value is ComputerToolDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<ComputerToolDetails>;
	return (
		Array.isArray(details.actions) &&
		Array.isArray(details.displays) &&
		Array.isArray(details.windows) &&
		(details.window === undefined || typeof details.window === "string") &&
		(details.width === undefined || typeof details.width === "number") &&
		(details.height === undefined || typeof details.height === "number")
	);
}

function actionDescription(args: ComputerRenderArgs | undefined): string | undefined {
	const window = typeof args?.window === "string" ? args.window : undefined;
	if (!window) return "list windows";
	const actions =
		Array.isArray(args?.actions) && args.actions.length > 0
			? args.actions.map(action => (typeof action?.type === "string" ? action.type : "action")).join(" → ")
			: "screenshot";
	return clean(`${window} · ${actions}`);
}

function windowName(details: ComputerToolDetails): string {
	if (!details.window) return "Windows";
	if (details.window === "desktop") return "Desktop";
	const window = details.windows.find(candidate => candidate.id === details.window);
	if (!window) return `window ${details.window}`;
	return [window.app, window.title].filter(Boolean).join(" — ") || `window ${details.window}`;
}

function resultDescription(details: ComputerToolDetails): string {
	if (!details.window) return clean(`Listed ${details.windows.length + 1} window targets`, 120);
	return clean(`${windowName(details)} · ${details.actions.join(" → ")} · ${details.width}×${details.height}`, 120);
}

function errorDescription(result: ComputerRenderResult, args: ComputerRenderArgs | undefined): string | undefined {
	const text = result.content.find(item => item.type === "text" && typeof item.text === "string")?.text;
	return text ? clean(text, 120) : actionDescription(args);
}

export const computerToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: ComputerRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(
			renderStatusLine({ icon: "pending", title: "Computer", description: actionDescription(args) }, theme),
			0,
			0,
		);
	},
	renderResult(
		result: ComputerRenderResult,
		options: RenderResultOptions,
		theme: Theme,
		args?: ComputerRenderArgs,
	): Component {
		const details = isComputerToolDetails(result.details) ? result.details : undefined;
		const header = renderStatusLine(
			result.isError
				? { icon: "error", title: "Computer", description: errorDescription(result, args) }
				: { icon: "success", title: "Computer", description: details ? resultDescription(details) : undefined },
			theme,
		);
		if (!details) return new Text(header, 0, 0);
		return framedBlock(theme, width => {
			const body: string[] = [
				theme.fg(
					"dim",
					`backend ${clean(details.backend)}${details.displayServer ? ` · server ${clean(details.displayServer)}` : ""} · capture ${clean(details.capturePermission)} · input ${clean(details.inputPermission)} · ${details.displays.length} display(s)`,
				),
			];
			const displayLimit = options.expanded
				? details.displays.length
				: Math.min(details.displays.length, PREVIEW_LIMITS.COLLAPSED_LINES);
			for (const display of details.displays.slice(0, displayLimit)) {
				body.push(
					theme.fg(
						"toolOutput",
						clean(
							`${display.id}${display.name ? ` ${display.name}` : ""}: logical ${display.x},${display.y} ${display.width}×${display.height}; pixels ${display.pixelX},${display.pixelY} ${display.pixelWidth}×${display.pixelHeight}; scale ${display.scale}${display.isPrimary ? "; primary" : ""}`,
							160,
						),
					),
				);
			}
			if (displayLimit < details.displays.length) {
				body.push(theme.fg("dim", `… ${details.displays.length - displayLimit} more display(s)`));
			}
			body.push(theme.fg("dim", `${details.windows.length + 1} window target(s)`));
			body.push(
				theme.fg(
					details.window === "desktop" ? "success" : "toolOutput",
					`desktop Desktop${details.window === "desktop" ? " · selected" : ""}`,
				),
			);
			const windowLimit = options.expanded
				? details.windows.length
				: Math.min(details.windows.length, PREVIEW_LIMITS.OUTPUT_COLLAPSED);
			for (const window of details.windows.slice(0, windowLimit)) {
				const identity = [window.app, window.title].filter(Boolean).join(" — ") || "Untitled";
				body.push(
					theme.fg(
						window.id === details.window ? "success" : "toolOutput",
						clean(
							`${window.id} ${identity}: ${window.x},${window.y} ${window.width}×${window.height}${window.focused ? " · focused" : ""}${window.id === details.window ? " · selected" : ""}`,
							160,
						),
					),
				);
			}
			if (windowLimit < details.windows.length) {
				body.push(theme.fg("dim", `… ${details.windows.length - windowLimit} more window(s)`));
			}
			if (details.capabilities) {
				body.push(theme.fg("dim", `capabilities ${clean(details.capabilities, 160)}`));
			}
			return {
				header,
				sections: [{ lines: body }],
				state: result.isError ? "error" : "success",
				borderColor: result.isError ? "error" : "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
};
