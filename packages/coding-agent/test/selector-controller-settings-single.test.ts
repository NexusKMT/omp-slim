import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { Component, OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import * as modelPickerModule from "@oh-my-pi/pi-tui/overlays/model-picker";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression: a second /settings (typed while theme discovery was pending, or
	// from Tern's native composer while the menu was open) stacked another
	// fullscreen settings menu on top of the first.
	it("focuses the open menu instead of stacking a second one", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus,
			},
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(overlays).toHaveLength(1);
		controller.showSettingsSelector();
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		let onCancel: (() => void) | undefined;
		vi.spyOn(modelPickerModule, "ModelPickerComponent").mockImplementation(function (...args: unknown[]) {
			onCancel = (args[4] as modelPickerModule.ModelPickerCallbacks).onCancel;
			return {};
		} as never);
		const ctx = createInteractiveModeContext({
			session: {
				model: undefined,
				scopedModels: [],
				getContextUsage: () => undefined,
				getRoleModelCycle: () => undefined,
			},
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus,
			},
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
		});
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);

		onCancel?.();
		controller.showModelSelector({ temporaryOnly: true });
		expect(overlays).toHaveLength(2);
	});
});
