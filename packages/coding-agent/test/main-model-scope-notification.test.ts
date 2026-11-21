import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { buildModelScopeNotification } from "@oh-my-pi/pi-coding-agent/main";
import { describe, expect, it } from "bun:test";
import { createTestModel } from "./helpers/test-model";

function scopedModel(id: string): ScopedModel {
	return {
		model: createTestModel({ provider: "test", id: id }),
		explicitThinkingLevel: false,
	};
}

describe("buildModelScopeNotification", () => {
	it("does not emit startup model scope chrome while startup.quiet is enabled", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], true)).toBeNull();
	});
});
