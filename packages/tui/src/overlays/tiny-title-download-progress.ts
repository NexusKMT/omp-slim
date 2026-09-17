import { type Component, truncateToWidth, visibleWidth } from "../index";
import { formatBytes } from "@oh-my-pi/pi-utils";
/** Download progress fields consumed by the status display. */
export interface TinyTitleDownloadProgress {
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
}
import { theme } from "../theme/theme";

const DEFAULT_BAR_WIDTH = 24;

function padLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? truncateToWidth(line, width) : `${line}${" ".repeat(width - visible)}`;
}

function progressBar(progress: number | undefined, width: number): string {
	const barWidth = Math.max(8, Math.min(DEFAULT_BAR_WIDTH, width));
	if (progress === undefined) return theme.fg("muted", "░".repeat(barWidth));
	const ratio = Math.max(0, Math.min(1, progress / 100));
	const filled = Math.round(ratio * barWidth);
	return `${theme.fg("accent", "█".repeat(filled))}${theme.fg("muted", "░".repeat(barWidth - filled))}`;
}

function currentFile(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event) return undefined;
	if (event.file) return event.file.split("/").at(-1) ?? event.file;
	if (event.files) {
		let largestFile: string | undefined;
		let largestLoaded = -1;
		for (const file in event.files) {
			const state = event.files[file];
			if (state.loaded <= largestLoaded || state.loaded >= state.total) continue;
			largestFile = file;
			largestLoaded = state.loaded;
		}
		return largestFile?.split("/").at(-1) ?? largestFile;
	}
	return undefined;
}

function statusLabel(event: TinyTitleDownloadProgress | undefined): string {
	if (!event) return "Preparing";
	if (event.status === "error") return "Failed";
	if (event.status === "ready") return "Ready";
	if (event.status === "done") return "Downloaded";
	if (event.status === "download") return "Downloading";
	if (event.status === "progress" || event.status === "progress_total") return "Downloading";
	return "Preparing";
}

function byteLabel(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event?.loaded || !event.total) return undefined;
	return `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
}

export class TinyTitleDownloadProgressComponent implements Component {
	#modelLabel: string;
	#event: TinyTitleDownloadProgress | undefined;

	constructor(modelLabel: string) {
		this.#modelLabel = modelLabel;
	}

	update(event: TinyTitleDownloadProgress): void {
		this.#event = event;
	}

	isComplete(): boolean {
		return this.#event?.status === "ready" || this.#event?.status === "error";
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const border = theme.fg("border", theme.boxRound.horizontal.repeat(width));
		const status = statusLabel(this.#event);
		const file = currentFile(this.#event);
		const pct =
			this.#event?.progress === undefined ? "" : `${Math.floor(this.#event.progress).toString().padStart(3, " ")}%`;
		const bytes = byteLabel(this.#event);
		const title = `${theme.fg("accent", "Tiny model")} ${theme.fg("muted", status)} ${this.#modelLabel}`;
		const details = [progressBar(this.#event?.progress, Math.max(8, width - 36)), pct, bytes, file]
			.filter((part): part is string => Boolean(part))
			.join(" ");

		return [border, padLine(` ${title}`, width), padLine(` ${details}`, width), border];
	}
}
