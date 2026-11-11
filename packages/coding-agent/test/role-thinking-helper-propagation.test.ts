import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, type Model } from "@oh-my-pi/pi-ai";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateTextReviewContextSummary } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-summary";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: (_kind = "chat") => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	};
}

function createSettings(modelRoles: Record<string, string>) {
	return Settings.isolated({ modelRoles });
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("current-model background helper calls", () => {
	it("keeps annotation summaries on the exact current model without server-side replacement", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), baseUrl: "https://custom.invalid" };
		const registry = createRegistry(model);
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "Preserve the original request and edit constraints." }],
		} as never);
		const sessionManager = SessionManager.inMemory();
		const summary = await generateTextReviewContextSummary(
			{ model, modelRegistry: registry as never, sessionManager },
			"An older message with edit constraints.",
		);
		expect(summary).toBe("Preserve the original request and edit constraints.");
		expect(complete.mock.calls[0]?.[0]).toBe(model);
		expect(complete.mock.calls[0]?.[2]?.disableServerSideFallback).toBe(true);
		expect(registry.resolver).toHaveBeenCalledWith(model, sessionManager.getSessionId());
	});

	it("uses the current model instead of a separate smol role for commit generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:minimal",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			undefined,
			model,
		);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(model);
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			disableServerSideFallback: true,
			maxTokens: 1024,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({
			smol: `${model.provider}/${model.id}`,
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			undefined,
			model,
		);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it("disables reasoning for title formatting on the current model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:low",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings, undefined, model);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
