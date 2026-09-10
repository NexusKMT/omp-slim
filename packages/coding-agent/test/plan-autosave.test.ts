import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import {
	autosaveApprovedPlan,
	defaultPlanAutosaveDir,
	resolvePlanAutosaveDir,
} from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	tempDir?.removeSync();
	tempDir = undefined;
	resetSettingsForTest();
});

function makeCwd(): string {
	tempDir = TempDir.createSync("@pi-plan-autosave-");
	return tempDir.path();
}

describe("plan autosave settings UI", () => {
	it("gates the autosave directory on plan.autosave", () => {
		const defs = getSettingsForTab("tasks");
		const autosave = defs.find(def => def.path === "plan.autosave");
		const autosaveDir = defs.find(def => def.path === "plan.autosaveDir");
		if (!autosave?.condition || !autosaveDir?.condition) {
			throw new Error("plan autosave settings should be gated on plan mode");
		}
		// Fresh defaults: plan mode on, autosave off.
		expect(autosave.condition()).toBe(true);
		expect(autosaveDir.condition()).toBe(false);

		Settings.instance.set("plan.autosave", true);
		expect(autosaveDir.condition()).toBe(true);

		Settings.instance.set("plan.enabled", false);
		expect(autosave.condition()).toBe(false);
		expect(autosaveDir.condition()).toBe(false);
	});
});

describe("resolvePlanAutosaveDir", () => {
	it("defaults to <project>/.omp/plans when unset", () => {
		const cwd = makeCwd();
		const settings = Settings.isolated();
		expect(resolvePlanAutosaveDir(settings, cwd)).toBe(path.join(cwd, ".omp", "plans"));
		expect(defaultPlanAutosaveDir(cwd)).toBe(path.join(cwd, ".omp", "plans"));
	});

	it("resolves absolute, tilde, and cwd-relative custom dirs", () => {
		const cwd = makeCwd();
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": path.join(cwd, "custom") }), cwd)).toBe(
			path.join(cwd, "custom"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "~/my-plans" }), cwd)).toBe(
			path.join(os.homedir(), "my-plans"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "docs/plans" }), cwd)).toBe(
			path.join(cwd, "docs", "plans"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "   " }), cwd)).toBe(
			path.join(cwd, ".omp", "plans"),
		);
	});
});

describe("autosaveApprovedPlan", () => {
	it("writes nothing when autosave is disabled", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated();
		const result = await autosaveApprovedPlan({
			settings,
			cwd,
			title: "Auth",
			planContent: "# Plan\n",
		});
		expect(result).toBeNull();
		expect(await Bun.file(path.join(cwd, ".omp", "plans", "AUTH_PLAN.md")).exists()).toBe(false);
	});

	it("saves the approved plan under the default dir", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const result = await autosaveApprovedPlan({
			settings,
			cwd,
			title: "Auth storage",
			planContent: "# Plan\n\nShip it.\n",
		});
		expect(result).toBe(path.join(cwd, ".omp", "plans", "AUTH_STORAGE_PLAN.md"));
		expect(await Bun.file(result!).text()).toBe("# Plan\n\nShip it.\n");
	});

	it("suffices colliding filenames instead of overwriting", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const first = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v1\n" });
		const second = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v2\n" });
		expect(first).toBe(path.join(cwd, ".omp", "plans", "AUTH_PLAN.md"));
		expect(second).toBe(path.join(cwd, ".omp", "plans", "AUTH_PLAN-1.md"));
		expect(await Bun.file(first!).text()).toBe("# v1\n");
		expect(await Bun.file(second!).text()).toBe("# v2\n");
	});
	it("keeps both plans when same-titled approvals race", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const [first, second] = await Promise.all([
			autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v1\n" }),
			autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v2\n" }),
		]);
		expect(new Set([first, second]).size).toBe(2);
		expect(new Set([await Bun.file(first!).text(), await Bun.file(second!).text()])).toEqual(
			new Set(["# v1\n", "# v2\n"]),
		);
	});

	it("skips empty plans", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const result = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "  \n" });
		expect(result).toBeNull();
	});
});
