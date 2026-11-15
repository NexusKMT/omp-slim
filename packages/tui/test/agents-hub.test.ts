/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, type-to-filter search, the Space enable/disable toggle, and the
 * picker's Toggle action persisting the selected agent's entry.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { AgentsHubComponent, type HubAgent, parseGeneratedAgentSpec } from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";
import type { DescribeContext } from "../src/native/node";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Settings double with a member-level writer; `writes` records every entry the hub touched. */
class TestSettings {
	readonly lists = new Map<string, string[]>();
	readonly writes: string[] = [];

	setMember(key: string, item: string, { member }: { member: boolean }): void {
		const rest = (this.lists.get(key) ?? []).filter(entry => entry !== item);
		this.lists.set(key, member ? [...rest, item] : rest);
		this.writes.push(`${key}[${item}]`);
	}
}

// Narrow TUI stub: the hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

async function createHub(settings: TestSettings): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		{
			loadAgents: async () => {
				const agents: HubAgent[] = [
					{ name: "dev", description: "Development agent", systemPrompt: "", source: "project", disabled: false },
					{
						name: "scout",
						description: "Read-only research",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
					{
						name: "task",
						description: "Generic task agent",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
				];
				for (const agent of agents) {
					agent.disabled = settings.lists.get("task.disabledAgents")?.includes(agent.name) ?? false;
				}
				return agents;
			},
			setAgentDisabled: (name, { disabled }) =>
				settings.setMember("task.disabledAgents", name, { member: disabled }),
			generateAgent: async () => {
				throw new Error("Agent generation is not used by configuration tests");
			},
			saveAgent: async () => {
				throw new Error("Agent creation is not used by configuration tests");
			},
		},
		{ onCancel: () => (cancelled = true) },
	);
	return {
		hub,
		strip: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		type: (text: string) => {
			for (const char of text) hub.handleInput(char);
		},
		cancelled: () => cancelled,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		const lines = hub.render(120);
		// top border + content rows + divider + footer + bottom border = terminal rows.
		expect(lines.length).toBe(30);
		const rendered = strip();
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("All agents");
		expect(rendered).toContain("Project");
		expect(rendered).toContain("Bundled");
		expect(rendered).toContain("dev");
		expect(rendered).toContain("scout");
		expect(rendered).toContain("+ New agent");
	});

	test("type-to-filter narrows the list and Esc clears the query first", async () => {
		const { hub, strip, type, cancelled } = await createHub(new TestSettings());
		type("sco");
		let rendered = strip();
		expect(rendered).toContain("scout");
		expect(rendered).not.toContain("dev");
		hub.handleInput("\x1b"); // Esc clears the query, not the hub
		expect(cancelled()).toBe(false);
		rendered = strip();
		expect(rendered).toContain("dev");
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(true);
	});
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles only the selected agent's entry", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["scout"]);
		const { hub } = await createHub(settings);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout", "dev"]);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout"]);
		expect(settings.writes).toEqual(["task.disabledAgents[dev]", "task.disabledAgents[dev]"]);
	});
});

/** The generic composition: a terminal without the `picker` kind. */
const cx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: kind => kind !== "picker",
	feature: () => true,
};
const pickerCx: DescribeContext = { ...cx, supports: () => true };

function pickerProps(hub: AgentsHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

describe("AgentsHub picker", () => {
	test("the Toggle action flips the selected agent even while a search query is typed", async () => {
		const settings = new TestSettings();
		const { hub, type } = await createHub(settings);
		type("dev");
		hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["dev"]);
		expect(pickerProps(hub).query).toBe("dev");
	});
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
