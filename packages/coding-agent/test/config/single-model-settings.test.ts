import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { cfgModel, cfgModelStorage } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgThemeDark } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	cfgModelLoopGuardEnabled,
	cfgModelLoopGuardCheckAssistantContent,
	cfgModelToolCallLoopGuardThreshold,
	cfgModelToolCallLoopGuardExemptTools,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	cfgRetryUsageReservePct,
	cfgFeaturesUnexpectedStopDetection,
} from "@oh-my-pi/pi-coding-agent/session/settings";
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
		expect(saved).toMatchObject({
			model: "anthropic/claude-sonnet-4-5:high",
			modelStorage: "project",
		});
		for (const key of ["modelRoles", "modelRoleStorage", "modelTags", "modelPresets", "cycleOrder"]) {
			expect(saved).not.toHaveProperty(key);
			expect(lookup(key)).toBeUndefined();
		}
		expect(saved).toHaveProperty("retry", {});
		expect(saved).toHaveProperty("task", {});
	});

	it("migrates legacy loop guards without losing the primary model or persisted controls", async () => {
		const file = path.join(agentDir, "config.yml");
		await Bun.write(
			file,
			YAML.stringify({
				model: {
					loopGuard: { enabled: false, checkAssistantContent: false },
					toolCallLoopGuard: { threshold: 8, exemptTools: ["read"] },
				},
				modelRoles: { default: "anthropic/primary:high", plan: "other/retired" },
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		expect(settings.getModel()).toBe("anthropic/primary:high");
		expect(cfgModelLoopGuardEnabled.get(settings)).toBe(false);
		expect(cfgModelLoopGuardCheckAssistantContent.get(settings)).toBe(false);
		expect(cfgModelToolCallLoopGuardThreshold.get(settings)).toBe(8);
		expect(cfgModelToolCallLoopGuardExemptTools.get(settings)).toEqual(["read"]);
		settings.setModel("openai/new:medium");
		await settings.flush();
		expect(YAML.parse(await Bun.file(file).text())).toEqual({
			model: "openai/new:medium",
			loopGuard: { enabled: false, checkAssistantContent: false },
			toolCallLoopGuard: { threshold: 8, exemptTools: ["read"] },
		});
		const dotted = Settings.isolated({
			model: "openai/current",
			"model.loopGuard.enabled": false,
			"model.toolCallLoopGuard.threshold": 7,
			loopGuard: { enabled: true },
		});
		expect(dotted.getModel()).toBe("openai/current");
		expect(cfgModelLoopGuardEnabled.get(dotted)).toBe(true);
		expect(cfgModelToolCallLoopGuardThreshold.get(dotted)).toBe(7);
	});

	it("retires automatic selectors while preserving local guards and credential reserve settings", () => {
		const settings = Settings.isolated({
			retry: {
				modelFallback: true,
				fallbackOn: "any",
				rateLimitWalksChain: true,
				usageAwareFallback: true,
				usageReservePolicy: "free",
				fallbackRevertPolicy: "cooldown-expiry",
				fallbackChains: { default: ["other/model"] },
				usageReservePct: 12,
			},
			providers: {
				anthropic: { serverSideFallback: true },
				autoThinkingMaxEffort: "max",
				tinyModelDevice: "cpu",
				tinyModelDtype: "fp16",
			},
			features: { unexpectedStopDetection: "smart" },
			images: { describeForTextModels: true },
			contextPromotion: { enabled: true },
			spelling: { autocomplete: "auto" },
			composer: { predictions: "on" },
			judgment: { attemptTimeoutMs: 3000 },
			prewalk: { enabled: true, auto: true },
			"prewalk.armed": true,
		});
		expect(cfgRetryUsageReservePct.get(settings)).toBe(12);
		expect(cfgFeaturesUnexpectedStopDetection.get(settings)).toBe("mechanical");
		expect(settings.getModel()).toBeUndefined();
		expect(lookup("judgment.attemptTimeoutMs")).toBeUndefined();
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
		expect(YAML.parse(await Bun.file(path.join(cwd, ".omp/config.yml")).text())).toMatchObject({ model: null });
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
		expect(YAML.parse(await Bun.file(file).text())).toMatchObject({ model: "p/saved" });
	});
});
