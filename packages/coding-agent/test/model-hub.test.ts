import { afterEach, beforeAll, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import {
	ModelHubComponent,
	resetProviderAutoRefreshGuard,
	type ModelHubRegistry,
	type ModelHubSource,
	type ModelHubCallbacks,
} from "@oh-my-pi/pi-tui/overlays/model-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const ui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;
const source: ModelHubSource = {
	revision: 0,
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	mruOrder: [],
	modelPerf: new Map(),
	disabledProviders: [],
};
const model = (provider: string, id: string, reasoning = false): Model =>
	buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
const a = model("one", "first"),
	b = model("two", "second", true);
function registry(models: Model[] = [a, b]): ModelHubRegistry {
	return {
		getAvailable: () => models,
		getAll: () => models,
		getError: () => undefined,
		authStorage: { keys: { source: () => ({ kind: "env", concrete: true }) } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	};
}
const hubs: ModelHubComponent[] = [];
function open(
	options: {
		registry?: ModelHubRegistry;
		callbacks?: Partial<ModelHubCallbacks>;
		scoped?: Model[];
		source?: ModelHubSource;
	} = {},
): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		options.source ?? source,
		options.registry ?? registry(),
		(options.scoped ?? [a, b]).map(model => ({ model })),
		{ onSelect: () => {}, onCancel: () => {}, ...options.callbacks },
		{ currentSelector: "one/first" },
	);
	hubs.push(hub);
	return hub;
}
function props(hub: ModelHubComponent): TspPickerProps {
	return hub.describe(cx).p as TspPickerProps;
}
function act(hub: ModelHubComponent, act: string, value?: string): void {
	hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
}
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
	resetProviderAutoRefreshGuard();
});

test("keeps provider search scoped until it loses every match, then searches the whole chat catalogue", () => {
	const hub = open();
	act(hub, "scope", "provider:one");
	hub.handleInput("first");
	expect(props(hub).scope).toBe("provider:one");
	expect(props(hub).order?.filter(item => typeof item === "string")).toEqual(["one/first"]);
	hub.handleInput("\x1b");
	hub.handleInput("second");
	expect(props(hub).scope).toBe("all");
	expect(props(hub).selected).toBe("two/second");
	expect(props(hub).scopes?.find(scope => scope.id === "provider:one")?.count).toBe(0);
});
test("a plain model applies directly and a reasoning model applies only after choosing its thinking level", async () => {
	const selections: string[] = [];
	const hub = open({
		callbacks: {
			onSelect: (_m, level, selector) => {
				selections.push(`${selector}:${level}`);
			},
		},
	});
	hub.handleNativeEvent({ type: "activate", key: "", item: "one/first" });
	await settle();
	expect(selections).toEqual(["one/first:off"]);
	hub.handleNativeEvent({ type: "activate", key: "", item: "two/second" });
	expect(selections).toHaveLength(1);
	hub.handleNativeEvent({ type: "activate", key: "", item: "off" });
	await settle();
	expect(selections).toEqual(["one/first:off", "two/second:off"]);
	expect(props(hub).current).toEqual(["two/second"]);
});
test("a rejected asynchronous selection keeps the current model and cannot be duplicated while pending", async () => {
	const pending = Promise.withResolvers<boolean>();
	let calls = 0;
	const hub = open({
		callbacks: {
			onSelect: () => {
				calls++;
				return pending.promise;
			},
		},
	});
	hub.handleNativeEvent({ type: "activate", key: "", item: "two/second" });
	hub.handleNativeEvent({ type: "activate", key: "", item: "off" });
	hub.handleNativeEvent({ type: "activate", key: "", item: "off" });
	expect(calls).toBe(1);
	pending.resolve(false);
	await settle();
	act(hub, "close");
	expect(props(hub).current).toEqual(["one/first"]);
});
test("an endpoint without credentials explains API key setup while configured discovery stays visible", async () => {
	const locked = model("locked", "remote");
	const r = registry([a]);
	r.getAll = () => [a, locked];
	r.authStorage.keys.source = provider => (provider === "one" ? { kind: "env", concrete: true } : undefined);
	r.getDiscoverableProviders = () => ["implicit", "custom"];
	r.getProviderDiscoveryState = provider =>
		provider === "implicit"
			? { optional: true, status: "unavailable" }
			: provider === "custom"
				? { optional: false, status: "empty" }
				: undefined;
	const hub = open({ registry: r, scoped: [] });
	await settle();
	expect(props(hub).scopes?.map(scope => scope.id)).not.toContain("provider:implicit");
	expect(props(hub).scopes?.map(scope => scope.id)).toContain("provider:custom");
	act(hub, "scope", "provider:locked");
	expect(props(hub).empty).toContain("API key in models.yml");
	expect(props(hub).actions?.find(action => action.id === "use")?.disabled).toBe(true);
	act(hub, "scope", "provider:custom");
	expect(props(hub).empty).toContain("returned 0 models");
});
test("F5 queues credential refresh behind an in-flight catalogue refresh and keeps it after leaving the provider", async () => {
	const pending = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const calls: (boolean | undefined)[] = [];
	const r = registry();
	r.refreshProvider = async (_p, _s, options) => {
		calls.push(options?.refreshCommandCredentials);
		if (calls.length === 1) {
			started.resolve();
			await pending.promise;
		}
	};
	const hub = open({ registry: r, scoped: [] });
	await settle();
	act(hub, "scope", "provider:one");
	await started.promise;
	act(hub, "refresh");
	act(hub, "scope", "all");
	pending.resolve();
	await settle();
	expect(calls).toEqual([undefined, true]);
});
test("the refreshed session scope replaces stale choices in the open hub", async () => {
	const refreshed = Promise.withResolvers<void>();
	const r = registry();
	r.refresh = () => refreshed.promise;
	const hub = open({ registry: r, scoped: [], callbacks: { onCatalogRefreshed: () => [{ model: b }] } });
	expect(props(hub).items?.map(item => item.id)).toContain("one/first");
	refreshed.resolve();
	await settle();
	expect(props(hub).order?.filter(item => typeof item === "string")).toEqual(["two/second"]);
});
test("compaction confirmation belongs to the exact draft value and preserves rejected input", () => {
	const updates: { value: string; confirmed: boolean }[] = [];
	const hub = open({
		callbacks: {
			onCompactionPointChange: (_m, value, confirmed) => {
				updates.push({ value, confirmed });
				return confirmed ? undefined : { kind: "confirm", message: "Uses extended context" };
			},
		},
	});
	act(hub, "compaction");
	hub.handleInput("400k");
	hub.handleInput("\r");
	hub.handleInput("0");
	hub.handleInput("\r");
	hub.handleInput("\r");
	expect(updates).toEqual([
		{ value: "400k", confirmed: false },
		{ value: "400k0", confirmed: false },
		{ value: "400k0", confirmed: true },
	]);
	expect(hub.nativeSheet(cx)).toBe(true);
});
