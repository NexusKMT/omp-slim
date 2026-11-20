import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

interface CostCtxOptions {
	cost?: number;
	/** Task-result portion of `cost`. */
	subagentCost?: number;
	subagentTreeCost?: number;
}

function costCtx(options: CostCtxOptions): SegmentContext {
	return {
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
			state: { model: undefined },
		},
	} as unknown as SegmentContext;
}

describe("cost status-line segment", () => {
	it("splits subagent spend out of the session's own cost", () => {
		const render = (options: Partial<CostCtxOptions>) =>
			stripVTControlCharacters(renderSegment("cost", costCtx({ ...options })).content);

		// Task results inside `cost` move to the suffix; the `$` is printed once.
		expect(render({ cost: 0.5, subagentCost: 0.12 })).toBe("$0.38 (+0.12)");
		// The tree total (grandchildren, running/async agents) wins when larger.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.4 })).toBe("$0.38 (+0.40)");
		// A lagging tree total (roster not hydrated yet) never drops below task results.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.05 })).toBe("$0.38 (+0.12)");
		// No subagent spend: no suffix.
		expect(render({ cost: 0.38 })).toBe("$0.38");
	});
});
