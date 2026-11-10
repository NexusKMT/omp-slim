import { beforeAll, describe, expect, test } from "bun:test";
import {
	AgentsHubComponent,
	type AgentsHubDeps,
	type HubAgent,
	parseGeneratedAgentSpec,
} from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";
import type { DescribeContext } from "../src/native/node";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const tui = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;
beforeAll(async () => {
	await initTheme(false);
});
const agents: HubAgent[] = [
	{ name: "dev", description: "Development", systemPrompt: "Implement changes", source: "project", disabled: false },
	{ name: "scout", description: "Research", systemPrompt: "Read files", source: "bundled", disabled: false },
];
function deps(writes: string[]): AgentsHubDeps {
	return {
		loadAgents: async () => structuredClone(agents),
		setAgentDisabled: (name, { disabled }) => writes.push(`${name}:${disabled}`),
		generateAgent: async () =>
			JSON.stringify({
				identifier: "code-reviewer",
				whenToUse: "Use this agent when reviewing code",
				systemPrompt: "Review the changes",
			}),
		saveAgent: async () => "/tmp/agents/code-reviewer.md",
	};
}
test("scope and search narrow the agents, and toggling touches only the selected persona", async () => {
	const writes: string[] = [];
	const hub = await AgentsHubComponent.create(tui, deps(writes));
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "bundled", mods: [] });
	expect((hub.describe(cx).p as TspPickerProps).items?.map(item => item.id)).toEqual(["agent:bundled:scout"]);
	hub.handleInput("scout");
	hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
	expect(writes).toEqual(["scout:true"]);
	expect((hub.describe(cx).p as TspPickerProps).items?.[0]?.chips).toContainEqual({ text: "disabled" });
	hub.handleInput("\x1b");
	expect((hub.describe(cx).p as TspPickerProps).query).toBe("");
	expect(hub.render(120)).toHaveLength(30);
	hub.dispose();
});
test("agent creation parses generated instructions and saves the selected scope", async () => {
	const saves: string[] = [];
	const options = deps([]);
	options.saveAgent = async (scope, spec) => {
		saves.push(`${scope}:${spec.identifier}`);
		return "/tmp/agents/code-reviewer.md";
	};
	const hub = await AgentsHubComponent.create(tui, options);
	hub.handleNativeEvent({ type: "action", key: "", act: "new", mods: [] });
	hub.handleInput("Review changed code");
	hub.handleNativeEvent({ type: "action", key: "", act: "generate", mods: [] });
	await Promise.resolve();
	await Promise.resolve();
	hub.handleNativeEvent({ type: "action", key: "", act: "save-scope", mods: [] });
	hub.handleNativeEvent({ type: "action", key: "", act: "save", mods: [] });
	await Promise.resolve();
	await Promise.resolve();
	expect(saves).toEqual(["user:code-reviewer"]);
	hub.dispose();
});
describe("parseGeneratedAgentSpec", () => {
	const spec = {
		identifier: "code-reviewer",
		whenToUse: "Use this agent when reviewing code.",
		systemPrompt: "Review the diff.",
	};

	test("parses plain JSON", () => {
		expect(parseGeneratedAgentSpec(JSON.stringify(spec))).toEqual(spec);
	});

	test("parses JSON wrapped in a json code fence", () => {
		const fence = "```";
		const raw = `Here you go:\n${fence}json\n${JSON.stringify(spec)}\n${fence}\n`;
		expect(parseGeneratedAgentSpec(raw)).toEqual(spec);
	});

	test("keeps a code fence inside a JSON string value", () => {
		const systemPrompt = "Emit this report:\n```\n# Report\n```\nThen stop.";
		const raw = JSON.stringify({ ...spec, systemPrompt });
		expect(parseGeneratedAgentSpec(raw).systemPrompt).toBe(systemPrompt);
	});
});
