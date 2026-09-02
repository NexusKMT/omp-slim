import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function source(provider: string): Rule["_source"] {
	return { provider, providerName: provider, path: "/tmp/rule.md", level: "user" };
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "body",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		astCondition: partial.astCondition,
		scope: partial.scope,
		agents: partial.agents,
		interruptMode: partial.interruptMode,
		_source: partial._source ?? source("native"),
	};
}

describe("agents frontmatter normalization", () => {
	it("lowercases a YAML sequence", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: [Scout, "foreman-*"]\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toEqual(["scout", "foreman-*"]);
	});

	it("splits a comma-separated string the same way", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: "scout, foreman-*"\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toEqual(["scout", "foreman-*"]);
	});

	it("normalizes an empty list to undefined", () => {
		const rule = buildRuleFromMarkdown(
			"scoped.md",
			`---\nagents: []\n---\nbody`,
			"scoped.md",
			createSourceMeta("test", "scoped.md", "project"),
		);
		expect(rule.agents).toBeUndefined();
	});
});

describe("bucketRules agent scoping", () => {
	it("bucketes a scout-only TTSR rule for scout and leaves it inert for main", () => {
		const rule = makeRule({
			name: "scout-only",
			condition: ["FORBIDDEN"],
			description: "blocks foo",
			agents: ["scout"],
		});

		const scoutMgr = new TtsrManager();
		const { rulebookRules: scoutRulebook, alwaysApplyRules: scoutAlways } = bucketRules([rule], scoutMgr, {
			agentName: "scout",
		});
		expect(scoutMgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual([
			"scout-only",
		]);
		expect(scoutRulebook).toHaveLength(0);
		expect(scoutAlways).toHaveLength(0);

		const mainMgr = new TtsrManager();
		const { rulebookRules: mainRulebook, alwaysApplyRules: mainAlways } = bucketRules([rule], mainMgr, {
			agentName: "main",
		});
		expect(mainMgr.hasRules()).toBe(false);
		expect(mainRulebook).toHaveLength(0);
		expect(mainAlways).toHaveLength(0);
	});

	it("`main` in the agents list includes the top-level session", () => {
		const rule = makeRule({ name: "main-only", condition: ["FORBIDDEN"], agents: ["main"] });
		const mgr = new TtsrManager();
		bucketRules([rule], mgr, { agentName: "main" });
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["main-only"]);
	});

	it("matches a glob pattern against the agent name", () => {
		const rule = makeRule({ name: "foreman-only", condition: ["FORBIDDEN"], agents: ["foreman-*"] });

		const alphaMgr = new TtsrManager();
		bucketRules([rule], alphaMgr, { agentName: "foreman-alpha" });
		expect(alphaMgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual([
			"foreman-only",
		]);

		const foremanMgr = new TtsrManager();
		bucketRules([rule], foremanMgr, { agentName: "foreman" });
		expect(foremanMgr.hasRules()).toBe(false);
	});

	it("a rule with no `agents` field applies to every agent", () => {
		const rule = makeRule({ name: "everyone", condition: ["FORBIDDEN"] });

		const mainMgr = new TtsrManager();
		bucketRules([rule], mainMgr, { agentName: "main" });
		expect(mainMgr.hasRules()).toBe(true);

		const scoutMgr = new TtsrManager();
		bucketRules([rule], scoutMgr, { agentName: "scout" });
		expect(scoutMgr.hasRules()).toBe(true);
	});

	it("gates the always-apply bucket too", () => {
		const rule = makeRule({ name: "scout-always", alwaysApply: true, agents: ["scout"] });

		const scoutMgr = new TtsrManager();
		const { alwaysApplyRules: scoutAlways } = bucketRules([rule], scoutMgr, { agentName: "scout" });
		expect(scoutAlways.map(r => r.name)).toEqual(["scout-always"]);

		const mainMgr = new TtsrManager();
		const { alwaysApplyRules: mainAlways } = bucketRules([rule], mainMgr, { agentName: "main" });
		expect(mainAlways).toHaveLength(0);
	});
});
