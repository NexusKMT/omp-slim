import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio primary model", () => {
	it("only accepts the configured primary model identity", () => {
		const settings = Settings.isolated({});
		settings.setModel(key(fast));
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast]);
		expect(selectorCandidates(fast.id, settings, registry)).toEqual([fast]);
		expect(selectorCandidates(key(mini), settings, registry)).toEqual([]);
	});

	it("rejects role and comma-list selection without trying alternatives", () => {
		const settings = Settings.isolated({});
		settings.setModel(key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([]);
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([]);
	});

	it("does not select a model when none is configured", () => {
		expect(selectorCandidates(key(fast), Settings.isolated({}), registry)).toEqual([]);
	});
});
