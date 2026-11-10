import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerGroup, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { ModelHubComponent, type ModelHubRegistry, type ModelHubSource } from "../src/overlays/model-hub";
import { ModelPickerComponent } from "../src/overlays/model-picker";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

const MODELS = [
	model("anthropic", "claude-sonnet-5-5", { int: 60 }),
	model("anthropic", "claude-opus-5"),
	model("demo", "demo"),
	model("openai", "gpt-5.6"),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

function source(mru: string[]): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		mruOrder: mru,
		modelPerf: new Map(),
		disabledProviders: [],
	};
}

function registry(models: Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}

const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

function openHub(calls: { assign: string[]; cancel: number }, models: Model[] = MODELS): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source(["demo/demo"]),
		registry(models),
		// A `--models` scope skips the background online refresh.
		models.map(entry => ({ model: entry })),
		{
			onSelect: (_model, _level, selector) => {
				calls.assign.push(selector);
			},
			onCancel: () => {
				calls.cancel++;
			},
		},
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	return hub;
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function groups(p: TspPickerProps): string[] {
	return (p.order ?? [])
		.filter((entry): entry is TspPickerGroup => typeof entry !== "string")
		.map(g => String(g.label));
}

/** A described child's prop, when the child is a node carrying it. */
function prop(child: NativeChild, name: string): unknown {
	return "k" in child && child.p ? Reflect.get(child.p, name) : undefined;
}

function titleOf(children: readonly NativeChild[] | undefined): unknown {
	const title = children?.find(child => prop(child, "role") === "omp.picker.title");
	return title ? prop(title, "text") : undefined;
}

test("the model hub describes a data-first picker when the terminal has the kind, else its generic frame", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	expect(hub.nativeSheet(withPicker)).toBe(true);
	expect(hub.nativeSheet(withoutPicker)).toBe(false);
	expect(hub.describe(withoutPicker).k).not.toBe("picker");

	const root = hub.describe(withPicker);
	const p = props(root);
	expect(p).toMatchObject({
		size: "screen",
		layout: "rows",
		preview: "side",
		icon: "cpu",
		title: "Models",
		scope: "all",
	});
	expect(p.scopes?.map(scope => scope.id)).toEqual([
		"recent",
		"all",
		"provider:anthropic",
		"provider:demo",
		"provider:openai",
	]);
	// Recent choices precede provider groups.
	expect(groups(p)).toEqual(["Recent", "anthropic", "openai"]);
	expect(p.current).toEqual(["demo/demo"]);
	expect(p.total).toBe(5);
	const demo = p.items?.find(entry => entry.id === "demo/demo");
	// Model rows lead with their provider's mark too.
	expect(demo?.mark).toEqual({ text: "De", seed: "demo", icon: "provider:demo" });
	expect(p.items?.find(entry => entry.id === "anthropic/claude-sonnet-5-5")?.facts?.int).toBe("60");
	expect(p.items?.find(entry => entry.id === "openai/gpt-5.6-mini")?.badges).toEqual([
		{ text: "free", tone: "success" },
	]);
	expect(titleOf(root.c)).toBe("demo");
});

test("typing changes the order, hits, counts and head total but never the catalogue", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const before = props(hub.describe(withPicker));
	for (const ch of "sonnet") hub.handleInput(ch);
	const after = props(hub.describe(withPicker));
	expect(after.items).toBe(before.items);
	expect(after.query).toBe("sonnet");
	expect(after.order?.filter(entry => typeof entry === "string")).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(after.hits?.["anthropic/claude-sonnet-5-5"]).toEqual([[17, 23]]);
	expect(after.total).toBe(5);
	expect(after.selected).toBe("anthropic/claude-sonnet-5-5");
});

test("pointer model and thinking selection changes the current model, while provider scopes keep filtering", async () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "provider:openai", mods: [] });
	expect(props(hub.describe(withPicker)).order?.filter(entry => typeof entry === "string")).toEqual([
		"openai/gpt-5.6",
		"openai/gpt-5.6-mini",
	]);
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	const thinking = props(hub.describe(withPicker));
	expect(thinking.items?.some(item => item.id === "off")).toBe(true);
	hub.handleNativeEvent({ type: "activate", key: "", item: "off" });
	await Promise.resolve();
	expect(calls.assign).toEqual(["openai/gpt-5.6"]);
	expect(props(hub.describe(withPicker)).current).toEqual(["openai/gpt-5.6"]);
	hub.handleInput("x");
	hub.handleInput("\x1b");
	expect(calls.cancel).toBe(0);
	hub.handleInput("\x1b");
	expect(calls.cancel).toBe(1);
});

test("the quick picker selects the current chat model through native activation", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source(["demo/demo"]),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(`session:${selector}`),
			onCancel: () => {},
		},
		{ currentSelector: "demo/demo" },
	);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	const root = picker.describe(withPicker);
	const p = props(root);
	expect(p).toMatchObject({ size: "md", preview: "below", title: "Switch model", selected: "demo/demo" });
	expect(p.scopes).toBeUndefined();
	expect(groups(p)).toEqual(["Recent", "All"]);
	expect(root.c?.some(child => prop(child, "layout") === "inline")).toBe(true);

	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["session:openai/gpt-5.6"]);
});

test("shows a non-default service tier's own speed aggregate", () => {
	const perf = new Map([
		["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
		["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
		["anthropic/claude-opus-5", { samples: 3, tps: 40, ttftMs: 300 }],
		["openai/gpt-5.6-mini@priority", { samples: 1, tps: 90, ttftMs: 200 }],
	]);
	const hub = new ModelHubComponent(
		ui,
		{
			...source(["demo/demo"]),
			modelPerf: perf,
			serviceTierFor: model => (model.provider === "openai" ? "ultrafast" : undefined),
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onSelect: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	const items = props(hub.describe(withPicker)).items ?? [];
	const speed = (id: string) => items.find(entry => entry.id === id)?.facts?.speed;
	// The tier the host would send wins over the standard aggregate.
	expect(speed("openai/gpt-5.6")).toBe("300 ultrafast");
	// No tier configured for the family: the standard aggregate, unlabeled.
	expect(speed("anthropic/claude-opus-5")).toBe("40");
	// Only a tier aggregate exists: show it rather than nothing.
	expect(speed("openai/gpt-5.6-mini")).toBe("90 priority");
});
