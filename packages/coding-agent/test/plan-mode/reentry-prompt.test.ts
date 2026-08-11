import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
	askAvailable: true,
	taskAvailable: true,
	scoutAvailable: true,
	reentry: false,
	planExists: true,
} as const;

type Overrides = Partial<Record<keyof typeof BASE, boolean | string>>;

function render(overrides: Overrides = {}): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("only emits the Re-entry section when re-entering", () => {
		expect(render({ reentry: false })).not.toContain("## Re-entry");
		expect(render({ reentry: true })).toContain("## Re-entry");
	});
});

describe("plan-mode-active tool availability", () => {
	it("omits ask-tool directives when ask is unavailable", () => {
		const withoutAsk = render({ askAvailable: false, iterative: true });
		expect(withoutAsk).not.toContain("`ask` with 2–4 mutually exclusive options");
		expect(withoutAsk).not.toContain("use `ask` for preferences and tradeoffs");
		expect(withoutAsk).not.toContain("Using `ask` to gather requirements");

		const withAsk = render({ askAvailable: true, iterative: true });
		expect(withAsk).toContain("`ask` with 2–4 mutually exclusive options");
		expect(withAsk).toContain("use `ask` for preferences and tradeoffs");
	});

	it("provides a prose fallback for preference collection when ask is unavailable", () => {
		const iterativeWithoutAsk = render({ askAvailable: false, iterative: true });
		expect(iterativeWithoutAsk).toContain("present the candidates with a recommendation in prose");
		expect(iterativeWithoutAsk).not.toContain("`ask` for preferences and tradeoffs only");

		const parallelWithoutAsk = render({ askAvailable: false, iterative: false });
		expect(parallelWithoutAsk).toContain("surface any remaining preference questions with a recommendation in prose");
	});

	it("omits scout-via-task dispatch when the task tool is unavailable", () => {
		const withoutTask = render({ taskAvailable: false, scoutAvailable: true });
		expect(withoutTask).not.toContain("(via `task`)");

		const withTask = render({ taskAvailable: true, scoutAvailable: true });
		expect(withTask).toContain("(via `task`)");
	});
});
