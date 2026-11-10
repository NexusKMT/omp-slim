import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { cfgModel, cfgModelStorage } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgThemeDark } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("single model settings", () => {
	let state: SettingsTestState;
	let temp: TempDir;
	let agentDir: string;
	let cwd: string;
	beforeEach(() => {
		state = beginSettingsTest();
		temp = TempDir.createSync("@pi-single-model-");
		agentDir = temp.join("agent");
		cwd = temp.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});
	afterEach(() => {
		restoreSettingsTestState(state);
		AgentStorage.close();
		Bun.gc(true);
		temp.removeSync();
	});

	it("migrates the legacy default and retires other model selectors on save", async () => {
		const file = path.join(agentDir, "config.yml");
		await Bun.write(
			file,
			YAML.stringify({
				modelRoles: { default: "anthropic/claude-sonnet-4-5:high", plan: "other/plan", custom: "other/custom" },
				modelRoleStorage: "project",
				modelTags: { custom: { name: "Custom" } },
				cycleOrder: ["custom"],
				modelPresets: { old: { modelRoles: { default: "other/preset" } } },
				retry: { fallbackChains: { default: ["other/fallback"] }, modelFallback: true },
				task: {
					agentModelOverrides: { scout: "other/scout" },
					perCallModel: "on",
					perCallModelAllow: ["other/model"],
					prewalk: true,
					agentPrewalk: { task: "other/fast" },
				},
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		expect(settings.getModel()).toBe("anthropic/claude-sonnet-4-5:high");
		expect(settings.getModelRoles()).toEqual({ default: "anthropic/claude-sonnet-4-5:high" });
		expect(settings.getModelRole("plan")).toBeUndefined();
		expect(cfgModelStorage.get(settings)).toBe("project");
		expect(() => settings.setModelRole("custom", "other/model")).toThrow("has been removed");
		expect(() => settings.overrideModelRoles({ plan: "other/model" })).toThrow("has been removed");
		cfgThemeDark.set(settings, "titanium");
		await settings.flush();
		const saved = YAML.parse(await Bun.file(file).text());
		expect(saved.model).toBe("anthropic/claude-sonnet-4-5:high");
		expect(saved.modelStorage).toBe("project");
		for (const key of ["modelRoles", "modelRoleStorage", "modelTags", "modelPresets", "cycleOrder"]) {
			expect(saved[key]).toBeUndefined();
			expect(lookup(key)).toBeUndefined();
		}
		expect(saved.retry).toEqual({});
		expect(saved.task).toEqual({});
	});

	it("keeps canonical model ownership including tombstones ahead of legacy values", () => {
		const canonical = Settings.isolated({ model: "openai/chosen:auto", modelRoles: { default: "other/old" } });
		expect(canonical.getModel()).toBe("openai/chosen:auto");
		const cleared = Settings.isolated({ model: null, "modelRoles.default": "other/old" });
		expect(cleared.getModel()).toBeUndefined();
		const dotted = Settings.isolated({ "modelRoles.default": "openai/chosen:off", "modelRoles.plan": "other/plan" });
		expect(dotted.getModel()).toBe("openai/chosen:off");
	});

	it("retains runtime, overlay, project and profile precedence after migration", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ modelRoles: { default: "p/profile" } }));
		await Bun.write(path.join(cwd, ".omp/config.yml"), YAML.stringify({ modelRoles: { default: "p/project" } }));
		const overlay = temp.join("overlay.yml");
		await Bun.write(overlay, YAML.stringify({ modelRoles: { default: "p/overlay" } }));
		const settings = await Settings.loadIsolated({
			agentDir,
			cwd,
			configFiles: [overlay],
			overrides: { "modelRoles.default": "p/runtime" },
		});
		expect(settings.getModel()).toBe("p/runtime");
		expect(settings.getModelProvenance()).toBe("runtime");
		settings.overrideModel(undefined);
		expect(settings.getModel()).toBe("p/overlay");
		expect(settings.getModelProvenance()).toBe("overlay");
		const project = await Settings.loadIsolated({ agentDir, cwd });
		expect(project.getModel()).toBe("p/project");
		project.clearProjectModel();
		expect(project.getModel()).toBe("p/profile");
		await project.flush();
		expect(YAML.parse(await Bun.file(path.join(cwd, ".omp/config.yml")).text()).model).toBeNull();
	});

	it("restores the original runtime model when moving after a project edit", async () => {
		const otherCwd = temp.join("other-project");
		fs.mkdirSync(otherCwd, { recursive: true });
		const settings = await Settings.loadIsolated({
			agentDir,
			cwd,
			overrides: { model: "p/cli", modelStorage: "project" },
		});
		settings.setProjectModel("p/project-edit");
		expect(settings.getModel()).toBe("p/project-edit");
		settings.setModel("p/profile-fallback");
		expect(settings.getModel()).toBe("p/project-edit");
		const moved = await settings.cloneForCwd(otherCwd);
		expect(moved.getModel()).toBe("p/cli");
		await settings.reloadForCwd(otherCwd);
		expect(settings.getModel()).toBe("p/cli");
		expect(settings.getGlobalModel()).toBe("p/profile-fallback");
	});

	it("persists only the selected model and preserves a later external edit", async () => {
		const file = path.join(agentDir, "config.yml");
		await Bun.write(file, YAML.stringify({ model: "p/original" }));
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		settings.setModel("p/local");
		await Bun.write(file, YAML.stringify({ model: "p/external", custom: { preserved: true } }));
		await settings.flush();
		expect(settings.getModel()).toBe("p/external");
		expect(YAML.parse(await Bun.file(file).text())).toEqual({ model: "p/external", custom: { preserved: true } });
		settings.overrideModel("p/temporary");
		settings.setModel("p/saved");
		expect(cfgModel.get(settings)).toBe("p/saved");
		await settings.flush();
		expect(YAML.parse(await Bun.file(file).text()).model).toBe("p/saved");
	});
});
