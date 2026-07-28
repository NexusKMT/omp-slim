import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Component, OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import {
	CodexResetFireworksController,
	detectCodexResetFireworks,
} from "../../../src/modes/components/codex-reset-fireworks";
import { getThemeByName, setThemeInstance, type Theme, theme } from "../../../src/modes/theme/theme";

type CodexResetFireworksHost = ConstructorParameters<typeof CodexResetFireworksController>[0];

interface FakeHost {
	host: CodexResetFireworksHost;
	shown: Component[];
	options: OverlayOptions[];
	focused: Component[];
	requestRenderCount(): number;
	hiddenCount(): number;
}

function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const options: OverlayOptions[] = [];
	const focused: Component[] = [];
	let renders = 0;
	let hidden = 0;
	const host: CodexResetFireworksHost = {
		ui: {
			showOverlay(component, nextOptions) {
				shown.push(component);
				options.push(nextOptions ?? {});
				return {
					hide() {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				} satisfies OverlayHandle;
			},
			setFocus(component) {
				focused.push(component);
			},
			requestRender() {
				renders++;
			},
			terminal: { rows },
		},
	};
	return {
		host,
		shown,
		options,
		focused,
		requestRenderCount: () => renders,
		hiddenCount: () => hidden,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("Codex reset fireworks", () => {
	let priorTheme: Theme | undefined;
	beforeAll(async () => {
		priorTheme = theme;
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("detects a 5-hour reset and prioritizes newly banked resets", () => {
		const previous = {
			fiveHour: { percent: 42, resetMinutes: 1 },
			sevenDay: { percent: 18, resetHours: 80 },
			savedResets: 0,
		};
		expect(
			detectCodexResetFireworks(previous, {
				fiveHour: { percent: 0, resetMinutes: 300 },
				sevenDay: { percent: 18.2, resetHours: 80 },
				savedResets: 0,
			}),
		).toEqual({ kind: "usage-window-reset" });
		expect(
			detectCodexResetFireworks(previous, {
				fiveHour: { percent: 0, resetMinutes: 300 },
				sevenDay: { percent: 18.2, resetHours: 80 },
				savedResets: 2,
			}),
		).toEqual({ kind: "saved-reset-banked", added: 2, available: 2 });
	});

	it("suppresses a 5-hour transition when only the weekly countdown restarts", () => {
		expect(
			detectCodexResetFireworks(
				{
					fiveHour: { percent: 42, resetMinutes: 1 },
					sevenDay: { percent: 18, resetHours: 80 },
				},
				{
					fiveHour: { percent: 0, resetMinutes: 300 },
					sevenDay: { percent: 18.2, resetHours: 168 },
				},
			),
		).toBeUndefined();
	});

	it("suppresses a 5-hour transition when only weekly usage drops", () => {
		expect(
			detectCodexResetFireworks(
				{
					fiveHour: { percent: 42, resetMinutes: 1 },
					sevenDay: { percent: 18, resetHours: 80 },
				},
				{
					fiveHour: { percent: 0, resetMinutes: 300 },
					sevenDay: { percent: 0, resetHours: 80 },
				},
			),
		).toBeUndefined();
	});

	it("renders distinct copy for usage-window and saved-reset celebrations", () => {
		const usage = makeHost();
		const usageController = new CodexResetFireworksController(usage.host);
		usageController.show({ kind: "usage-window-reset" });
		const usageText = usage.shown[0]?.render(80).map(stripVTControlCharacters).join("\n") ?? "";

		const saved = makeHost();
		const savedController = new CodexResetFireworksController(saved.host);
		savedController.show({ kind: "saved-reset-banked", added: 1, available: 3 });
		const savedText = saved.shown[0]?.render(80).map(stripVTControlCharacters).join("\n") ?? "";

		expect(usageText).toContain("C O D E X   R E S E T");
		expect(usageText).toContain("5-hour window: 0% used");
		expect(savedText).toContain("S A V E D   R E S E T");
		expect(savedText).toContain("New reset banked · 3 available");
		expect(savedText).not.toContain("5-hour window");

		usageController.dispose();
		savedController.dispose();
	});

	it("holds a top-third modal until Escape and ignores overlapping celebrations", async () => {
		const fake = makeHost(24);
		const controller = new CodexResetFireworksController(fake.host);
		expect(controller.show({ kind: "usage-window-reset" })).toBe(true);
		expect(controller.show({ kind: "saved-reset-banked", added: 1, available: 1 })).toBe(false);
		expect(fake.shown).toHaveLength(1);
		expect(fake.focused).toEqual(fake.shown);
		expect(fake.options[0]).toMatchObject({ anchor: "top-center", width: "100%", maxHeight: "33%", margin: 0 });
		expect(fake.shown[0]?.render(80)).toHaveLength(7);

		vi.advanceTimersByTime(5_000);
		expect(fake.requestRenderCount()).toBeGreaterThan(FRAME_COUNT_FOR_THREE_SECONDS);
		expect(fake.hiddenCount()).toBe(0);

		const component = fake.shown[0];
		component?.handleInput?.("x");
		expect(fake.hiddenCount()).toBe(0);
		component?.handleInput?.("\x1b");
		await flushMicrotasks();
		expect(fake.hiddenCount()).toBe(1);
		controller.dispose();
	});
});

const FRAME_COUNT_FOR_THREE_SECONDS = Math.floor(3_000 / 85);
