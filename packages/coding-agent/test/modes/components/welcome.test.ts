import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("WelcomeComponent tips", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});
});

// Regression coverage for the stale welcome banner bug: the component is
// constructed with the session model at init time, but init-time model changes
// (plan.defaultOnStartup, #reconcileModeFromSession, delayed config load) can
// swap the model before the model_changed subscription exists. The catch-up
// resync in InteractiveMode.init() calls setModel() after those steps; these
// tests verify setModel() produces the correct rendered output.
describe("WelcomeComponent model name", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	it("updates the rendered model name after setModel()", () => {
		const welcome = new WelcomeComponent("1.0.0", "DeepSeek V4 Pro", "deepseek");
		const before = welcome.render(100).join("\n");
		expect(before).toContain("DeepSeek V4 Pro");

		welcome.setModel("GLM-5.2", "zhipu-coding-plan");
		const after = welcome.render(100).join("\n");
		expect(after).toContain("GLM-5.2");
		expect(after).not.toContain("DeepSeek V4 Pro");
	});

	it("resyncs to the live model after init-time model switches (catch-up path)", () => {
		// Banner constructed with the pre-config fallback model (the startup race
		// picks an alphabetically-first provider before modelRoles.default loads).
		const welcome = new WelcomeComponent("1.0.0", "DeepSeek V4 Pro", "deepseek");
		expect(welcome.render(100).join("\n")).toContain("DeepSeek V4 Pro");

		// Config loads, session switches to the real default — the model_changed
		// event fires before the subscription exists, so InteractiveMode.init()
		// calls setModel() explicitly as a catch-up resync.
		welcome.setModel("GLM-5.2", "zhipu-coding-plan");
		const rendered = welcome.render(100).join("\n");
		expect(rendered).toContain("GLM-5.2");
		expect(rendered).toContain("zhipu-coding-plan");
		expect(rendered).not.toContain("DeepSeek");
	});
});
