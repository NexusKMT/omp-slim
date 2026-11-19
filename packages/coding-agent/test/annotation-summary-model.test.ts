import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-ai/build";
import { generateTextReviewContextSummary } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-summary";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

describe("annotation summary model", () => {
	it("keeps annotation summaries on the exact current model without server-side replacement", async () => {
		const model = buildModel({ provider: "gateway", id: "selected", baseUrl: "https://custom.invalid/v1" });
		const registry = { resolver: vi.fn(() => async () => "test-key") };
		const complete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("Preserve the original request and edit constraints."));
		const sessionManager = SessionManager.inMemory();
		const summary = await generateTextReviewContextSummary(
			{ model, modelRegistry: registry as never, sessionManager },
			"An older message with edit constraints.",
		);
		expect(summary).toBe("Preserve the original request and edit constraints.");
		expect(complete.mock.calls[0]?.[0]).toBe(model);
		expect(registry.resolver).toHaveBeenCalledWith(model, sessionManager.getSessionId());
	});
});
