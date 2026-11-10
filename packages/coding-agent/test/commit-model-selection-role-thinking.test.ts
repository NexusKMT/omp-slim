import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolvePrimaryModel } from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

describe("commit single-model selection", () => {
	it("uses the configured primary model and its thinking level", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const settings = Settings.isolated({
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}:high`,
				commit: `${commitModel.provider}/${commitModel.id}:low`,
				smol: "@default:minimal",
			},
		});
		const authStorage = createInMemoryAuthStorage();
		try {
			const registry = {
				getAvailable: () => [defaultModel, commitModel],
				getApiKey: async () => "test-key",
				getApiKeyForProvider: async () => "test-key",
				getApiKeyWithCredentialForProvider: async () => "test-key",
				authStorage,
				resolver: () => async () => "test-key",
			};

			const primary = await resolvePrimaryModel(undefined, settings, registry);
			expect(primary.model.id).toBe(defaultModel.id);
			expect(primary.thinkingLevel).toBe(Effort.High);
		} finally {
			authStorage.close();
		}
	});
});
