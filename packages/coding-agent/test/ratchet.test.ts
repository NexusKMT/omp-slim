import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { createRatchetPrelude } from "@oh-my-pi/pi-coding-agent/ratchet/prelude";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";

const FLOW = "router";
const CASES = Array.from({ length: 10 }, (_, index) => `case_${index}`);

type Answer = "Approve" | "Revise" | "timeout";

interface Harness {
	root: string;
	prelude: EvalPreludeDefinition;
	call(params: Record<string, unknown>, answer?: Answer): Promise<any>;
	writeRows(
		variant: string,
		grade: (id: string) => number,
		extra?: (id: string) => Record<string, unknown>,
	): Promise<void>;
	split: { train_ids: string[]; test_ids: string[] };
}

function dialog(answer: Answer): () => Promise<ExtensionAskDialogResult> {
	return async () => ({
		kind: "submit",
		results: [
			{
				id: "stage",
				question: "approve?",
				options: ["Approve", "Revise", "Abort"],
				multi: false,
				selectedOptions: answer === "timeout" ? ["Approve"] : [answer],
				customInput: answer === "Revise" ? "drop case_3" : undefined,
				timedOut: answer === "timeout",
			},
		],
	});
}

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ratchet-"));
	await Bun.write(path.join(root, "eval/cases.jsonl"), CASES.map(id => JSON.stringify({ id })).join("\n"));
	await Bun.write(path.join(root, "eval/run.ts"), "// runner\n");
	await Bun.write(path.join(root, "src/prompt.md"), "route emails\n");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function setup(options: { hold?: string[]; models?: unknown[] } = {}): Promise<Harness> {
	const session = {
		cwd: root,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		modelRegistry: { getAll: () => options.models ?? [] },
	} as unknown as ToolSession;
	const prelude = createRatchetPrelude(session);
	const call: Harness["call"] = async (params, answer = "Approve") => {
		const context = {
			hasUI: true,
			ui: { askDialog: dialog(answer), input: async () => "typed" },
		} as unknown as AgentToolContext;
		const result = await prelude.invoke({ flow: FLOW, ...params }, { session, toolCallId: "t", context });
		return result.details;
	};
	await call({ action: "init", cases: ["eval/cases.jsonl"], harness: ["eval/run.ts"], change: ["src/prompt.md"] });
	await call({
		action: "plan",
		goal: { target: "quality", hold: options.hold ?? [] },
		reps: 1,
		command: "bun eval/run.ts --variant {variant}",
	});
	const split = await call({ action: "split", cases: Object.fromEntries(CASES.map(id => [id, "billing"])), seed: 7 });
	const writeRows: Harness["writeRows"] = async (variant, grade, extra) => {
		const rows = CASES.map(id =>
			JSON.stringify({ prompt_id: id, rep: 0, grade: { quality: grade(id) }, ...extra?.(id) }),
		);
		await Bun.write(path.join(root, ".omp/ratchet", FLOW, variant, "results.jsonl"), `${rows.join("\n")}\n`);
	};
	return { root, prelude, call, writeRows, split };
}

async function approveAll(harness: Harness): Promise<void> {
	for (const stage of ["inputs", "grader", "plan"]) {
		const outcome = await harness.call({ action: "approve", stage, question: "ok?", preview: "table" });
		expect(outcome.approved).toBe(true);
	}
}

describe("ratchet gate", () => {
	it("keeps a change only when train and test both improve, and reverts a train-only gain as overfit", async () => {
		const harness = await setup();
		await approveAll(harness);
		const train = new Set(harness.split.train_ids);

		await harness.writeRows("baseline", () => 0.2);
		expect((await harness.call({ action: "gate", variant: "baseline" })).decision).toBe("baseline");

		await harness.writeRows("v1", () => 0.5);
		const kept = await harness.call({ action: "gate", variant: "v1", change: "define each queue" });
		expect(kept.decision).toBe("keep");
		expect(kept.best.variant).toBe("v1");

		await harness.writeRows("v2", id => (train.has(id) ? 0.9 : 0.5));
		const overfit = await harness.call({ action: "gate", variant: "v2", change: "quote failing emails" });
		expect(overfit.decision).toBe("revert");
		expect(overfit.reasons.join(" ")).toContain("overfit");
		expect(overfit.best.variant).toBe("v1");
	});

	it("reverts a target gain that regresses a guardrail", async () => {
		const harness = await setup({ hold: ["cost_usd"] });
		await approveAll(harness);
		await harness.writeRows(
			"baseline",
			() => 0.2,
			() => ({ cost_usd: 0.01 }),
		);
		await harness.call({ action: "gate", variant: "baseline" });
		await harness.writeRows(
			"v1",
			() => 0.6,
			() => ({ cost_usd: 0.05 }),
		);
		const gate = await harness.call({ action: "gate", variant: "v1", change: "switch to bigger model" });
		expect(gate.decision).toBe("revert");
		expect(gate.reasons.join(" ")).toContain("cost_usd");
	});

	it("refuses to gate a run that wrote transcripts for held-out cases", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		const leaked = harness.split.test_ids[0]!;
		await Bun.write(path.join(root, ".omp/ratchet", FLOW, "baseline/traces", `${leaked}_rep0.json`), "[]");
		await expect(harness.call({ action: "gate", variant: "baseline" })).rejects.toThrow(/test cases/);
	});

	it("refuses to gate an incomplete run", async () => {
		const harness = await setup();
		await approveAll(harness);
		const rows = [JSON.stringify({ prompt_id: CASES[0], rep: 0, grade: { quality: 1 } })];
		await Bun.write(path.join(root, ".omp/ratchet", FLOW, "baseline/results.jsonl"), rows.join("\n"));
		await expect(harness.call({ action: "gate", variant: "baseline" })).rejects.toThrow(/incomplete/);
	});
});

describe("ratchet approvals", () => {
	it("marks the grader approval stale when the harness changes after approval", async () => {
		const harness = await setup();
		await approveAll(harness);
		await Bun.write(path.join(root, "eval/run.ts"), "// runner that now reads the answer key\n");
		const status = await harness.call({ action: "status" });
		expect(status.approval_status).toEqual({ inputs: "current", grader: "stale", plan: "current" });
		await expect(harness.call({ action: "check", variant: "baseline" })).rejects.toThrow(/grader: stale/);
	});

	it("does not record an approval from a timed-out or revised answer", async () => {
		const harness = await setup();
		expect(
			await harness.call({ action: "approve", stage: "inputs", question: "ok?", preview: "t" }, "timeout"),
		).toMatchObject({ approved: false });
		expect(
			await harness.call({ action: "approve", stage: "inputs", question: "ok?", preview: "t" }, "Revise"),
		).toEqual({ approved: false, aborted: false, feedback: "drop case_3" });
		expect((await harness.call({ action: "status" })).approval_status.inputs).toBe("missing");
	});

	it("rejects approval without an interactive UI", async () => {
		const harness = await setup();
		await expect(
			harness.prelude.invoke(
				{ flow: FLOW, action: "approve", stage: "inputs", question: "ok?", preview: "t" },
				{ session: {} as ToolSession, toolCallId: "t", context: { hasUI: false } as unknown as AgentToolContext },
			),
		).rejects.toThrow(/interactive session/);
	});
});

describe("ratchet split and cost", () => {
	it("freezes the split once the baseline is gated", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		await harness.call({ action: "gate", variant: "baseline" });
		await expect(
			harness.call({ action: "split", cases: Object.fromEntries(CASES.map(id => [id, "x"])), seed: 1 }),
		).rejects.toThrow(/frozen/);
	});

	it("prices rows from the model catalog and leaves unknown models unpriced", async () => {
		const models = [
			{ id: "known-model", provider: "p", cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 } },
		];
		const harness = await setup({ models });
		await approveAll(harness);
		await harness.writeRows(
			"baseline",
			() => 0.2,
			id => ({
				model: id === CASES[0] ? "mystery-model" : "known-model",
				usage: { input_tokens: 1000, output_tokens: 500 },
			}),
		);
		const gate = await harness.call({ action: "gate", variant: "baseline" });
		// 1000 in × $10/MTok + 500 out × $20/MTok = $0.02 per priced case.
		const cost = gate.table.split("\n")[2];
		expect(cost).toContain("0.0200");
		expect(gate.warnings.join(" ")).toContain("mystery-model");
	});
});
