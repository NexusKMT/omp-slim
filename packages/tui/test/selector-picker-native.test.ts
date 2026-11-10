import { beforeAll, describe, expect, it } from "bun:test";
import type { TspKind, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { HookSelectorComponent } from "../src/overlays/hook-selector";
import { ThemeSelectorComponent } from "../src/overlays/theme-selector";
import { ThinkingSelectorComponent } from "../src/overlays/thinking-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: (kind: TspKind) => kind !== "picker",
	feature: () => true,
};

/** The hoisted picker child of a docked selector's root. */
function sheet(root: NativeNode | null): { props: TspPickerProps } {
	const child = root?.c?.[0] as NativeNode | undefined;
	expect(child?.k).toBe("picker");
	return { props: child!.p as TspPickerProps };
}

const at = (type: "select" | "activate", item: string) => ({ type, key: "^picker", item }) as const;
const act = (id: string) => ({ type: "action", key: "^picker", act: id, mods: [] }) as const;

describe("theme selector picker", () => {
	function make() {
		const log: string[] = [];
		const selector = new ThemeSelectorComponent(
			"dark",
			["dark", "light", "nord"],
			name => log.push(`select:${name}`),
			() => log.push("cancel"),
			name => log.push(`preview:${name}`),
		);
		return { selector, log };
	}

	it("describes a picker with swatch marks and the current theme, else the card", () => {
		const { selector } = make();
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.items?.map(item => item.id)).toEqual(["dark", "light", "nord"]);
		expect(p.items?.[2]?.mark?.seed).toBe("nord");
		expect(p.current).toEqual(["dark"]);
		expect(p.selected).toBe("dark");
		expect(p.actions?.map(a => a.label)).toEqual(["Apply", "Close"]);
		expect(selector.describe(genericCx)?.c?.[0]).not.toMatchObject({ k: "picker" });
	});

	it("row click previews, second click applies, close reverts via cancel", () => {
		const { selector, log } = make();
		selector.handleNativeEvent(at("select", "nord"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("nord");
		selector.handleNativeEvent(at("activate", "nord"));
		selector.handleNativeEvent(act("close"));
		expect(log).toEqual(["preview:nord", "select:nord", "cancel"]);
	});
});

describe("thinking selector picker", () => {
	it("meters each level's depth, deeper levels fuller", () => {
		const selector = new ThinkingSelectorComponent(
			"high" as never,
			["low", "high"] as never,
			() => {},
			() => {},
		);
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.columns?.map(c => c.format)).toEqual(["bar"]);
		const depth = (id: string) => p.items?.find(item => item.id === id)?.facts?.depth as number;
		expect(depth("high")).toBeGreaterThan(depth("low"));
		expect(depth("high")).toBeLessThanOrEqual(1);
		expect(p.current).toEqual(["high"]);
	});

	it("marks auto as current without a depth meter; off meters empty", () => {
		const withAuto = new ThinkingSelectorComponent(
			"auto",
			["off", "auto", "high"] as never,
			() => {},
			() => {},
		);
		const p = sheet(withAuto.describe(pickerCx)).props;
		expect(p.current).toEqual(["auto"]);
		expect(p.selected).toBe("auto");
		expect(p.items?.find(item => item.id === "auto")?.facts).toBeUndefined();
		expect(p.items?.find(item => item.id === "off")?.facts?.depth).toBe(0);
	});
});

describe("hook selector picker", () => {
	it("pointer select moves the selection without confirming; confirm picks it", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Pick",
			["one", "two"],
			o => picked.push(o),
			() => {},
		);
		selector.handleNativeEvent(at("select", "1"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("1");
		expect(picked).toEqual([]);
		selector.handleNativeEvent(act("confirm"));
		expect(picked).toEqual(["two"]);
	});

	it("inline stays in the dock as a card instead of a hoisted picker sheet", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Save where?",
			["project", "global"],
			o => picked.push(o),
			() => {},
			{ inline: true },
		);
		const root = selector.describe(pickerCx);
		expect(JSON.stringify(root)).not.toContain('"k":"picker"');
		selector.handleNativeEvent({ type: "activate", key: "list", item: "1" });
		expect(picked).toEqual(["global"]);
	});
});
