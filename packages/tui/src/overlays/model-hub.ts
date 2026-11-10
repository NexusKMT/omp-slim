/** Provider catalogue and current chat model/thinking selection. */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { Component, TUI } from "../tui";
import { sanitizeDisplayWarning } from "../render/render-utils";
import { Input } from "../components/input";
import { routeSgrMouseInput } from "../mouse";
import { card } from "../native/describe";
import { matchesKey } from "../keys";
import { theme } from "../theme/theme";
import { truncateToWidth } from "../utils";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import {
	type ModelBrowserSource,
	type ModelBrowserRegistry,
	type ModelBrowserItem,
	buildBrowserItems,
	sortModelItems,
	ModelBrowser,
	ModelItemRanker,
	buildSearchAffinity,
	MODEL_PICKER_COLUMNS,
} from "./model-browser";
import { HubFrame, describeHubFrame, describeHubSidebar, type SidebarEntry } from "./hub-frame";
import { ThinkingSelectorComponent } from "./thinking-selector";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "../native/picker";
import { span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow } from "../native/overlay";

export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
}
export interface ModelHubRegistry extends ModelBrowserRegistry {
	refresh(): Promise<void>;
}
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}
export type CompactionPointChangeResult = { kind: "error" | "confirm"; message: string };
export interface ModelHubCallbacks {
	onCompactionPointChange?: (
		model: Model,
		input: string,
		confirmed: boolean,
	) => CompactionPointChangeResult | undefined;
	previewCompactionPoint?: (model: Model, input: string) => string | undefined;
	onSelect: (
		model: Model,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
	) => void | boolean | Promise<void | boolean>;
	onModelsReloaded?: () =>
		| ReadonlyArray<ScopedModelItem>
		| undefined
		| Promise<ReadonlyArray<ScopedModelItem> | undefined>;
	onCancel: () => void;
}
export interface ModelHubOptions {
	initialProviderId?: string;
	currentSelector?: string;
	currentContextTokens?: number;
	thinkingLevel?: ConfiguredThinkingLevel;
}
interface Scope extends SidebarEntry<"recent" | "all" | "provider"> {
	providerId?: string;
	locked?: boolean;
}

export class ModelHubComponent implements Component {
	#browser: ModelBrowser;
	#frame: HubFrame;
	#entries: Scope[] = [];
	#items: ModelBrowserItem[] = [];
	#active = "all";
	#sidebar = false;
	#error: string | undefined;
	#refreshing = false;
	#disposed = false;
	#thinking: ThinkingSelectorComponent | undefined;
	#currentSelector: string | undefined;
	#thinkingLevel: ConfiguredThinkingLevel | undefined;
	#pending = false;
	#ranker: ModelItemRanker | undefined;
	#compaction:
		| { model: Model; input: Input; confirm?: { value: string; message: string }; error?: string }
		| undefined;
	constructor(
		private tui: TUI,
		private settings: ModelHubSource,
		private registry: ModelHubRegistry,
		private scopedModels: ReadonlyArray<ScopedModelItem>,
		private callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#currentSelector = options.currentSelector;
		this.#thinkingLevel = options.thinkingLevel ?? parseConfiguredThinkingLevel(settings.defaultThinkingLevel);
		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			markOverContext: true,
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.setCurrentSelector(this.#currentSelector);
		this.#browser.onActivate = item => this.#chooseThinking(item);
		this.#browser.onCancel = callbacks.onCancel;
		this.#browser.onQueryChange = query => {
			const scope = this.#scope();
			if (
				query.trim() &&
				scope?.kind === "provider" &&
				!this.#matches().some(item => item.provider === scope.providerId)
			)
				this.#setScope("all");
		};
		this.#frame = new HubFrame(
			"Models",
			{ min: 16, max: 28 },
			(width, rows) =>
				this.#frame.renderSidebar(
					this.#entries,
					width,
					rows,
					{ id: this.#active, focused: this.#sidebar, follow: true, clamp: true },
					entry => ({
						icon: entry.locked ? theme.status.disabled : "",
						annotation: entry.annotation ?? "",
						muted: entry.locked,
					}),
				),
			(width, rows) => {
				this.#browser.setMaxVisible(Math.max(5, (rows ?? 20) - 5));
				return this.#compaction
					? [
							"Compaction limit (400k, f400k, 80%, or empty to reset)",
							...this.#compaction.input.render(width),
							this.#compaction.error ??
								this.#compaction.confirm?.message ??
								this.callbacks.previewCompactionPoint?.(
									this.#compaction.model,
									this.#compaction.input.getValue(),
								) ??
								"",
						]
					: this.#thinking
						? this.#thinking.render(width)
						: this.#scope()?.locked
							? [truncateToWidth("Configure an API key in models.yml to use this endpoint", width)]
							: this.#browser.render(width);
			},
			{ bodyMinWidth: 28, preserveSidebar: true },
		);
		this.#sync();
		if (options.initialProviderId) this.#setScope(`provider:${options.initialProviderId}`);
		if (this.#currentSelector) this.#browser.selectSelector(this.#currentSelector);
	}
	refreshAfterExternalMutation(): void {
		this.#sync();
		this.#repaint();
	}
	dispose(): void {
		this.#disposed = true;
	}
	invalidate(): void {
		this.#frame.invalidate();
	}
	#scope(): Scope | undefined {
		return this.#entries.find(entry => entry.id === this.#active);
	}
	#repaint(): void {
		if (!this.#disposed) this.tui.requestRender();
	}
	#sync(): void {
		const scoped = this.scopedModels.length > 0;
		const all = (scoped ? this.scopedModels.map(entry => entry.model) : this.registry.getAll("chat")).filter(
			model => modelKind(model) === "chat",
		);
		let available: Model[] = [];
		try {
			available = scoped ? all : this.registry.getAvailable("chat").filter(model => modelKind(model) === "chat");
		} catch (error) {
			this.#error = String(error);
		}
		this.#items = buildBrowserItems(available);
		sortModelItems(this.#items, { mruOrder: this.settings.mruOrder });
		this.#ranker = new ModelItemRanker(this.#items, {
			mruOrder: this.settings.mruOrder,
			affinity: buildSearchAffinity(this.settings.modelProviderOrder, this.settings.mruOrder),
		});
		this.#browser.setMruOrder(this.settings.mruOrder);
		this.#browser.setPerfStats(this.settings.modelPerf);
		const providers = new Set(all.map(model => model.provider));
		const order = this.settings.modelProviderOrder;
		const sorted = [...providers]
			.filter(provider => !this.settings.disabledProviders.includes(provider))
			.sort((a, b) => {
				const ar = order.indexOf(a),
					br = order.indexOf(b);
				return (ar < 0 ? Infinity : ar) - (br < 0 ? Infinity : br) || a.localeCompare(b);
			});
		this.#entries = [
			{ id: "recent", kind: "recent", label: "Recent" },
			{ id: "all", kind: "all", label: "All models", annotation: String(available.length) },
			...sorted.map(provider => ({
				id: `provider:${provider}`,
				kind: "provider" as const,
				label: provider,
				providerId: provider,
				annotation: String(available.filter(model => model.provider === provider).length),
				locked: !available.some(model => model.provider === provider),
			})),
		];
		if (!this.#entries.some(entry => entry.id === this.#active)) this.#active = "all";
		this.#applyScope();
	}
	#matches(): readonly ModelBrowserItem[] {
		return this.#ranker?.rank(this.#browser.query) ?? this.#items;
	}
	#emptyStateMessage(): string {
		if (this.#error) return sanitizeDisplayWarning(this.#error);
		const scope = this.#scope();
		if (scope?.kind === "recent") return "No recently used models yet";
		if (scope?.locked) return "Configure an API key in models.yml to use this endpoint";
		return "No models configured. Add a Chat Completions endpoint in models.yml, then reload.";
	}

	#openCompaction(): void {
		const item = this.#browser.getSelected();
		if (!item || !this.callbacks.onCompactionPointChange) return;
		const input = new Input();
		input.setValue(this.settings.compactionPointFor?.(item.model)?.draft ?? "");
		this.#compaction = { model: item.model, input };
		this.#repaint();
	}
	#submitCompaction(): void {
		const draft = this.#compaction;
		if (!draft) return;
		const value = draft.input.getValue();
		const result = this.callbacks.onCompactionPointChange?.(draft.model, value, draft.confirm?.value === value);
		if (result?.kind === "error") {
			draft.error = result.message;
			draft.confirm = undefined;
		} else if (result?.kind === "confirm") {
			draft.error = undefined;
			draft.confirm = { value, message: result.message };
		} else {
			this.#compaction = undefined;
			this.#sync();
		}
		this.#repaint();
	}
	#applyScope(): void {
		const scope = this.#scope();
		const items =
			scope?.kind === "provider"
				? this.#items.filter(item => item.provider === scope.providerId)
				: scope?.kind === "recent"
					? this.#items.filter(item => this.settings.mruOrder.includes(item.selector))
					: this.#items;
		this.#browser.setItems(items);
		this.#browser.setShowProvider(scope?.kind !== "provider");
	}
	#setScope(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#active = id;
		this.#applyScope();
		this.#repaint();
	}
	async #refresh(): Promise<void> {
		if (this.#refreshing) return;
		this.#refreshing = true;
		this.#error = undefined;
		this.#repaint();
		try {
			await this.registry.refresh();
			const scope = await this.callbacks.onModelsReloaded?.();
			if (scope !== undefined) this.scopedModels = scope;
			if (!this.#disposed) this.#sync();
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			this.#refreshing = false;
			this.#repaint();
		}
	}

	#chooseThinking(item: ModelBrowserItem): void {
		if (this.#pending) return;
		if (!item.model.reasoning) {
			void this.#select(item, ThinkingLevel.Off);
			return;
		}
		const levels = [
			ThinkingLevel.Off,
			...(item.model.thinking?.unverified ? [] : [AUTO_THINKING]),
			...getSupportedEfforts(item.model),
		];
		this.#thinking = new ThinkingSelectorComponent(
			this.#thinkingLevel,
			levels,
			level => {
				void this.#select(item, level);
			},
			() => {
				this.#thinking = undefined;
				this.#repaint();
			},
			{ docked: false },
		);
		this.#repaint();
	}
	async #select(item: ModelBrowserItem, level: ConfiguredThinkingLevel): Promise<void> {
		if (this.#pending) return;
		this.#pending = true;
		try {
			const accepted = await this.callbacks.onSelect(item.model, level, item.selector);
			if (accepted !== false) {
				this.#currentSelector = item.selector;
				this.#thinkingLevel = level;
				this.#browser.setCurrentSelector(item.selector);
				this.#thinking = undefined;
			}
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			this.#pending = false;
			this.#repaint();
		}
	}
	handleInput(data: string): void {
		if (this.#compaction) {
			if (matchesKey(data, "escape")) this.#compaction = undefined;
			else if (matchesKey(data, "enter")) this.#submitCompaction();
			else this.#compaction.input.handleInput(data);
			this.#repaint();
			return;
		}
		if (
			routeSgrMouseInput(data, event => {
				const hit = this.#frame.locate(event.row, event.col);
				if (hit.overSidebar) {
					if (event.wheel) this.#frame.sidebarScroll = Math.max(0, this.#frame.sidebarScroll + event.wheel);
					else if (event.leftClick) {
						const entry = this.#entries[this.#frame.sidebarScroll + hit.contentLine];
						if (entry) this.#setScope(entry.id);
					}
				} else if (hit.overBody) {
					if (this.#thinking) this.#thinking.routeMouse(event, hit.bodyLine, event.col);
					else this.#browser.routeMouse(event, hit.bodyLine);
				}
				this.#repaint();
			})
		)
			return;
		if (matchesKey(data, "ctrl+l")) {
			this.#openCompaction();
			return;
		}
		if (this.#thinking) {
			this.#thinking.getSelectList().handleInput(data);
			return;
		}
		if (matchesKey(data, "f5")) {
			void this.#refresh();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#sidebar = !this.#sidebar;
			this.#browser.setFocused(!this.#sidebar);
			this.#repaint();
			return;
		}
		if (this.#sidebar) {
			const index = this.#entries.findIndex(entry => entry.id === this.#active);
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const next = (index + (matchesKey(data, "up") ? -1 : 1) + this.#entries.length) % this.#entries.length;
				this.#setScope(this.#entries[next]!.id);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "right")) {
				this.#sidebar = false;
				this.#browser.setFocused(true);
				return;
			}
			if (matchesKey(data, "escape")) {
				this.callbacks.onCancel();
				return;
			}
			this.#sidebar = false;
			this.#browser.setFocused(true);
		}
		this.#browser.handleInput(data);
	}
	render(width: number): string[] {
		const status = this.#error
			? sanitizeDisplayWarning(this.#error)
			: this.#refreshing
				? "Reloading models.yml…"
				: "tab providers · enter select model and thinking · ctrl+l compaction · F5 reload · esc close";
		return [
			...this.#frame.render(
				width,
				this.tui.terminal?.rows || process.stdout.rows || 30,
				this.#entries,
				theme.fg(this.#error ? "error" : "dim", status),
			),
		];
	}
	nativeSheet(cx: DescribeContext): boolean {
		return !this.#compaction && cx.supports("picker");
	}
	describe(cx?: DescribeContext): NativeNode {
		if (this.#compaction)
			return card({ role: "omp.overlay.model-compaction", head: "Compaction limit" }, [
				text("400k base · f400k fixed · 80% window · empty resets"),
				this.#compaction.input,
				text(
					this.#compaction.error ??
						this.#compaction.confirm?.message ??
						this.callbacks.previewCompactionPoint?.(this.#compaction.model, this.#compaction.input.getValue()) ??
						"",
				),
				hintsRow([
					{ keys: ["enter"], label: "save" },
					{ keys: ["esc"], label: "cancel" },
				]),
			]);
		if (this.#thinking && cx) return this.#thinking.describe(cx)!;
		const scope = this.#scope();
		const subtitle = this.#error
			? [span(this.#error, "error")]
			: this.#refreshing
				? "Reloading models.yml…"
				: "Choose the current chat model and thinking level";
		if (!cx?.supports("picker"))
			return describeHubFrame(
				"omp.overlay.model-hub",
				"Models",
				describeHubSidebar(this.#entries, this.#active, entry => ({
					icon: "",
					annotation: entry.annotation ?? "",
					muted: entry.locked,
				})),
				scope?.locked ? text("Configure an API key in models.yml to use this endpoint") : this.#browser,
				hintsRow([
					actionHint("tui.select.cancel", "close"),
					{ keys: ["tab"], label: "providers" },
					{ keys: ["enter"], label: "select model and thinking" },
				]),
			);
		const view = this.#browser.pickerOrder({ providers: scope?.kind !== "provider", rest: "Models" });
		return picker(
			{
				title: "Models",
				subtitle,
				icon: "cpu",
				noun: "models",
				size: "screen",
				layout: "rows",
				preview: "side",
				placeholder: "Search models…",
				columns: MODEL_PICKER_COLUMNS,
				scopes: this.#entries.map(entry => ({
					id: entry.id,
					label: entry.label,
					count: this.#browser.query.trim()
						? this.#matches().filter(
								item =>
									entry.kind === "all" ||
									(entry.kind === "recent"
										? this.settings.mruOrder.includes(item.selector)
										: item.provider === entry.providerId),
							).length
						: entry.annotation
							? Number(entry.annotation)
							: undefined,
				})),
				scope: this.#active,
				...this.#browser.pickerRows(this.#browser.pickerItems(this.#items), view, this.#currentSelector),
				empty: this.#emptyStateMessage(),
				actions: [
					pickerAction("use", "Select model and thinking", "enter", {
						primary: true,
						disabled: scope?.locked || undefined,
					}),
					...(this.callbacks.onCompactionPointChange
						? [pickerAction("compaction", "Compaction limit", "ctrl+l")]
						: []),
					pickerAction("refresh", "Reload models.yml", "f5"),
					CLOSE_ACTION,
				],
			},
			this.#browser.pickerPreview("full", this.#currentSelector),
		);
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#compaction) return;
		if (this.#thinking) {
			this.#thinking.handleNativeEvent(event);
			return;
		}
		if (event.key === "sidebar" && (event.type === "select" || event.type === "activate")) {
			this.#setScope(event.item);
			return;
		}
		if (event.key.startsWith("body")) {
			this.#browser.handleNativeEvent({ ...event, key: event.key.replace(/^body\.?/, "") });
			return;
		}
		const picked = pickerEvent(event);
		if (!picked) return;
		if (picked.kind === "action" && picked.act === "scope" && picked.value) {
			this.#setScope(picked.value);
			return;
		}
		if (picked.kind !== "action") {
			this.#browser.routePickerItem(picked.item, picked.kind === "activate");
			return;
		}
		if (picked.act === "compaction") this.#openCompaction();
		else if (picked.act === "refresh") void this.#refresh();
		else if (picked.act === "use") {
			const item = this.#browser.getSelected();
			if (item) this.#chooseThinking(item);
		} else if (picked.act === CLOSE_ACTION.id) this.#browser.handleCancel();
	}
}
