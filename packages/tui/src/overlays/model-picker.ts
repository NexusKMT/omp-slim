/** Compact picker for the current chat model. */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "../tui";
import { theme } from "../theme/theme";
import {
	buildSessionModelScope,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelPickerCatalogue,
	type ModelBrowserRegistry,
	type ModelBrowserSource,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { card, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "../native/picker";
import { actionHint, hintsRow } from "../native/overlay";

export interface ModelPickerRegistry extends ModelBrowserRegistry {
	refreshIfStale(): Promise<boolean>;
}
export interface ModelPickerCallbacks {
	onPick: (model: Model, selector: string, meta: { overContext: boolean }) => void;
	onCancel: () => void;
}
export interface ModelPickerOptions {
	currentContextTokens?: number;
	currentSelector?: string;
}
const CHROME_ROWS = 4;
export const BROWSER_FRAME_ROWS = 5;
const MIN_VISIBLE = 5;
const HEIGHT_FRACTION = 0.4;

export class ModelPickerComponent implements Component {
	#browser: ModelBrowser;
	#configError: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#pickerRoot:
		| {
				memo: string;
				catalogue: ModelPickerCatalogue;
				order: object;
				preview: readonly NativeChild[];
				node: NativeNode;
		  }
		| undefined;
	constructor(
		private tui: TUI,
		private settings: ModelBrowserSource,
		private registry: ModelPickerRegistry,
		private scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		private options: ModelPickerOptions = {},
	) {
		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			markOverContext: true,
		});
		this.#browser.setCurrentSelector(options.currentSelector);
		this.#browser.onActivate = item =>
			callbacks.onPick(item.model, item.selector, { overContext: this.#browser.isOverContext(item) });
		this.#browser.onCancel = callbacks.onCancel;
		this.#sync();
		if (options.currentSelector) this.#browser.selectSelector(options.currentSelector);
		if (scopedModels.length === 0) {
			registry
				.refreshIfStale()
				.then(changed => {
					if (changed) this.#sync();
				})
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => tui.requestRender());
		}
	}
	invalidate(): void {}
	#sync(): void {
		const scope = buildSessionModelScope(
			this.settings,
			this.registry,
			this.scopedModels.map(entry => entry.model),
		);
		this.#configError = scope.error;
		this.#modelItems = scope.items;
		this.#browser.setMruOrder(scope.mruOrder);
		this.#browser.setPerfStats(this.settings.modelPerf);
		this.#browser.setItems(this.#modelItems);
	}
	handleInput(data: string): void {
		if (!data.startsWith("\x1b[<")) this.#browser.handleInput(data);
	}
	render(width: number): string[] {
		const rows = Math.max(16, this.tui.terminal?.rows || process.stdout.rows || 40);
		this.#browser.setMaxVisible(
			Math.max(MIN_VISIBLE, Math.floor(rows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS),
		);
		const title = "Switch Model";
		const footer = `${editorKeys("tui.select.up", "tui.select.down")} models · ${formatKeyHint("enter")} select · ${editorKey("tui.select.cancel")} close`;
		return [
			topBorder(width, title),
			row(
				theme.fg(this.#configError ? "error" : "muted", this.#configError ?? "Choose the current chat model"),
				width,
			),
			...this.#browser.render(Math.max(1, width - 4)).map(line => row(line, width)),
			row(theme.fg("dim", footer), width),
			bottomBorder(width),
		];
	}
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}
	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (!picked) return;
		if (picked.kind !== "action") {
			this.#browser.routePickerItem(picked.item, picked.kind === "activate");
			return;
		}
		if (picked.act === "use") {
			const selected = this.#browser.pickerSelected;
			if (selected) this.#browser.routePickerItem(selected, true);
		} else if (picked.act === CLOSE_ACTION.id || picked.act === "clear") this.#browser.handleCancel();
	}
	describe(cx?: DescribeContext): NativeNode {
		if (!cx?.supports("picker"))
			return card({ role: "omp.overlay.model-picker", head: "Select Model" }, [
				text([span(this.#configError ?? "Choose the current chat model", this.#configError ? "error" : "muted")]),
				this.#browser,
				hintsRow([
					actionHint(["tui.select.up", "tui.select.down"], "models"),
					{ keys: ["enter"], label: "select model" },
					actionHint("tui.select.cancel", "close"),
				]),
			]);
		const query = this.#browser.query;
		const view = this.#browser.pickerOrder({ providers: false, rest: query.trim() ? "Matches" : "All" });
		const catalogue = this.#browser.pickerItems(this.#modelItems);
		const preview = this.#browser.pickerPreview("compact", this.options.currentSelector);
		const memo = `${this.#configError ?? ""}\0${query}\0${this.#browser.cursor}\0${this.#browser.pickerSelected ?? ""}`;
		const cached = this.#pickerRoot;
		if (
			cached?.memo === memo &&
			cached.catalogue === catalogue &&
			cached.order === view &&
			cached.preview === preview
		)
			return cached.node;
		const root = picker(
			{
				title: "Switch model",
				subtitle: this.#configError ? [span(this.#configError, "error")] : "Choose the current chat model",
				icon: "cpu",
				noun: "models",
				size: "md",
				layout: "rows",
				preview: "below",
				placeholder: "Search models…",
				...this.#browser.pickerRows(catalogue, view, this.options.currentSelector),
				empty: "No models available",
				actions: [
					pickerAction("use", "Select model", "enter", { primary: true }),
					query ? { ...CLOSE_ACTION, label: "Clear search" } : CLOSE_ACTION,
				],
			},
			preview,
		);
		this.#pickerRoot = { memo, catalogue, order: view, preview, node: root };
		return root;
	}
}
