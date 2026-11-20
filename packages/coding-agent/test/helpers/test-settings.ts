import { vi } from "bun:test";
import * as definitions from "@oh-my-pi/pi-coding-agent/config/all-settings";
import * as registry from "@oh-my-pi/pi-coding-agent/config/registry";
import { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";

// Handles are deliberately not registered in the process-wide production registry.
export const cfgTestEnabled = new Setting<boolean>({ id: "test.enabled", type: "boolean", default: false });
export const cfgTestMode = new Setting<"off" | "1" | "3" | "5" | "strict">({
	id: "test.mode",
	type: "enum",
	values: ["off", "1", "3", "5", "strict"],
	default: "off",
});
export const cfgTestToken = new Setting<string | undefined>({
	id: "test.token",
	type: "string",
	default: undefined,
	credential: true,
});
export const cfgTestEndpoint = new Setting<string>({
	id: "test.endpoint",
	type: "string",
	default: "https://default.example",
	ui: {
		tab: "tools",
		group: "Test Fixtures",
		label: "Test endpoint",
		description: "Endpoint used by configuration tests",
	},
});

/** Install explicit settings for one test; its afterEach must call vi.restoreAllMocks(). */
export function installTestSettings(): void {
	const fixtures = [cfgTestEnabled, cfgTestMode, cfgTestToken, cfgTestEndpoint];
	const ordered = definitions.orderedSettings();
	const all = registry.all();
	const lookup = registry.lookup;
	vi.spyOn(definitions, "orderedSettings").mockReturnValue([...ordered, ...fixtures]);
	vi.spyOn(registry, "all").mockReturnValue([...all, ...fixtures]);
	vi.spyOn(registry, "lookup").mockImplementation(id => fixtures.find(setting => setting.id === id) ?? lookup(id));
}
