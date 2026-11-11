import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import {
	resolveAgentServiceTierOverride,
	validateAgentServiceTierOverrides,
} from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgTierOpenai, cfgTierSubagent } from "@oh-my-pi/pi-coding-agent/session/settings";

const openAIModel = getBundledModel("endpoint", "chat-model");

// Locks the back-compat migration of the legacy single `serviceTier` enum (with
// scoped `openai-only`/`claude-only` sentinels) plus `serviceTierSubagent`/
// `serviceTierAdvisor`/`fastModeScope` into the per-family `tier.*` settings.
describe("serviceTier → tier.* settings migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-service-tier-migration-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	it("migrates unscoped priority to the Chat service tier", async () => {
		const settings = await loadWith({ serviceTier: "priority" });
		expect(cfgTierOpenai.get(settings)).toBe("priority");
	});

	it("migrates the Chat legacy tier and retires the other protocol tier", async () => {
		const openai = await loadWith({ serviceTier: "openai-only" });
		expect(cfgTierOpenai.get(openai)).toBe("priority");

		const claude = await loadWith({ serviceTier: "claude-only" });
		expect(cfgTierOpenai.get(claude)).toBe("none");
	});

	it("maps plain OpenAI tiers onto the OpenAI family", async () => {
		const settings = await loadWith({ serviceTier: "flex" });
		expect(cfgTierOpenai.get(settings)).toBe("flex");
	});

	it("carries the subagent tier over and drops retired advisor settings", async () => {
		const settings = await loadWith({
			serviceTierSubagent: "claude-only",
			serviceTierAdvisor: "flex",
		});
		expect(cfgTierSubagent.get(settings)).toBe("priority"); // claude-only → priority
	});
});

describe("task.agentServiceTierOverrides", () => {
	it("resolves every documented setting for the OpenAI family", () => {
		const parentTiers: ServiceTierByFamily = { openai: "priority" };

		expect(resolveAgentServiceTierOverride("inherit", openAIModel, parentTiers)).toEqual(parentTiers);
		expect(resolveAgentServiceTierOverride("none", openAIModel, parentTiers)).toEqual({});
		expect(resolveAgentServiceTierOverride("auto", openAIModel, parentTiers)).toEqual({ openai: "auto" });
		expect(resolveAgentServiceTierOverride("default", openAIModel, parentTiers)).toEqual({ openai: "default" });
		expect(resolveAgentServiceTierOverride("flex", openAIModel, parentTiers)).toEqual({ openai: "flex" });
		expect(resolveAgentServiceTierOverride("scale", openAIModel, parentTiers)).toEqual({ openai: "scale" });
		expect(resolveAgentServiceTierOverride("priority", openAIModel, parentTiers)).toEqual({ openai: "priority" });
	});

	it("rejects values outside the documented service-tier set during settings load", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentServiceTierOverrides": { scout: "turbo" } },
			}),
		).rejects.toThrow(
			"Invalid service tier for task.agentServiceTierOverrides.scout: turbo. Expected one of: inherit, none, auto, default, flex, scale, priority, ultrafast.",
		);
	});

	it("rejects a scalar or array container during settings load instead of disabling every override", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentServiceTierOverrides": "priority" },
			}),
		).rejects.toThrow(
			"Invalid task.agentServiceTierOverrides: expected a map of agent name to service tier, got a string.",
		);
		expect(() => validateAgentServiceTierOverrides([{ scout: "priority" }])).toThrow(
			"Invalid task.agentServiceTierOverrides: expected a map of agent name to service tier, got an array.",
		);
		// An empty YAML mapping (`agentServiceTierOverrides:`) is `null`, not a typo.
		expect(validateAgentServiceTierOverrides(null)).toEqual({});
	});

	it("never broadcasts a concrete value across families when no model resolved", () => {
		const inherited: ServiceTierByFamily = { openai: "flex" };
		expect(resolveAgentServiceTierOverride("priority", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("scale", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("none", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("inherit", undefined, inherited)).toEqual(inherited);
	});
});
