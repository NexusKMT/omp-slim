import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

const scheduledModel = buildModel({
	id: "scheduled-chat",
	provider: "custom",
	name: "Scheduled chat",
	api: "openai-completions",
	baseUrl: "http://localhost:8000/v1",
	input: ["text"],
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 4096,
	cost: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		timeBased: {
			offPeakMultiplier: 0.5,
			peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 240 }],
		},
	},
});

interface CostCtxOptions {
	cost?: number;
	/** Task-result portion of `cost`. */
	subagentCost?: number;
	subagentTreeCost?: number;
	advisorCost?: number;
	model?: Model;
	now?: Date;
}

function costCtx(options: CostCtxOptions): SegmentContext {
	return {
		now: options.now,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: options.cost ?? 0,
			subagentCost: options.subagentCost,
			tokensPerSecond: null,
		},
		subagentTreeCost: options.subagentTreeCost,
		session: {
			state: { model: options.model },
			getAdvisorCost: () => options.advisorCost ?? 0,
		},
	} as unknown as SegmentContext;
}

describe("cost status-line segment", () => {
	it("shows the active scheduled tariff without repricing accumulated spend", () => {
		const model: Model = scheduledModel;
		const ctx = costCtx({
			cost: 1.25,
			model,
			now: new Date("2026-09-10T03:59:59.999Z"),
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25 ↑");
		ctx.now = new Date("2026-09-10T04:00:00Z");
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25 ↓");

		// History and accumulated spend stay put; only the active model changes.
		const { timeBased: _schedule, ...flatCost } = model.cost;
		ctx.session.state.model = { ...model, provider: "custom", cost: flatCost };
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25");
		expect(ctx.usageStats.cost).toBe(1.25);
	});

	it("shows a scheduled tariff before the first paid request but keeps ordinary zero spend hidden", () => {
		const ctx = costCtx({
			model: scheduledModel,
			now: new Date("2026-09-12T02:00:00Z"),
		});
		const rendered = renderSegment("cost", ctx);
		expect(rendered.visible).toBe(true);
		expect(stripVTControlCharacters(rendered.content)).toBe("$0.00 ↓");
		const { timeBased: _schedule, ...flatCost } = ctx.session.state.model!.cost;
		ctx.session.state.model = { ...ctx.session.state.model!, cost: flatCost };
		expect(renderSegment("cost", ctx).visible).toBe(false);
	});

	it("keeps the tariff adjacent to primary spend before advisor billing", () => {
		const ctx = costCtx({
			cost: 1.25,
			advisorCost: 0.5,
			model: scheduledModel,
			now: new Date("2026-09-10T02:00:00Z"),
		});
		const rendered = stripVTControlCharacters(renderSegment("cost", ctx).content);
		expect(rendered).toMatch(/1\.25.*↑ \+ .*0\.50/);
		expect(rendered).not.toContain("↓");
	});

	it("splits subagent spend out of the session's own cost", () => {
		const render = (options: Partial<CostCtxOptions>) =>
			stripVTControlCharacters(renderSegment("cost", costCtx(options)).content);

		// Task results inside `cost` move to the suffix; the `$` is printed once.
		expect(render({ cost: 0.5, subagentCost: 0.12 })).toBe("$0.38 (+0.12)");
		// The tree total (grandchildren, running/async agents) wins when larger.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.4 })).toBe("$0.38 (+0.40)");
		// A lagging tree total (roster not hydrated yet) never drops below task results.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.05 })).toBe("$0.38 (+0.12)");
		// No subagent spend: no suffix.
		expect(render({ cost: 0.38 })).toBe("$0.38");
	});

	it("never repeats a billing unit symbol across session and advisor spend", () => {
		const render = (options: Partial<CostCtxOptions>) =>
			stripVTControlCharacters(renderSegment("cost", costCtx(options)).content);
		const metered = render({ cost: 0.42, subagentTreeCost: 0.1, advisorCost: 0.08 });
		expect(metered.split("$")).toHaveLength(2);
		expect(metered).toMatch(/^\$0\.42 \(\+0\.10\) \+ .*0\.08/);
	});
});
