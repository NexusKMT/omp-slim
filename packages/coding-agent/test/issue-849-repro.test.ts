import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * Issue #849: After a user explicitly switches to test-model, the session reverts
 * to test-model-2 on resume.
 *
 * Root cause hypothesis: buildSessionContext walks entries in path order and
 * overwrites `models.default` from every assistant message's reported model.
 * When a temporary fallback (e.g. retry fallback or a server-side downgrade
 * in the provider) emits an assistant message tagged with the older
 * model id, that id clobbers the user's explicitly chosen default.
 *
 * Contract under test: an explicit `model_change` with role="default" must
 * win over assistant-message inference from later messages produced under a
 * temporary or downgraded model.
 */
describe("issue #849: explicit default model survives later assistant-message inference", () => {
	function makeAssistantEntry(
		id: string,
		parentId: string | null,
		provider: string,
		model: string,
	): SessionMessageEntry {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: provider as AssistantMessage["provider"],
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(`2026-04-30T00:00:0${id.slice(-1)}Z`),
		};
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
	}

	function makeModelChange(id: string, parentId: string | null, model: string, role: string): ModelChangeEntry {
		return {
			type: "model_change",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			model,
			role,
		};
	}

	it("preserves explicit user-selected default when a later assistant message reports a downgraded model", () => {
		// User explicitly picks test-model as default.
		// Then a temporary fallback (retry / context promotion) appends a
		// model_change with role="temporary" pointing at test-model-2, and the
		// next assistant message is produced under that temporary model.
		const entries: SessionEntry[] = [
			makeModelChange("a1", null, "test/test-model", "default"),
			makeAssistantEntry("a2", "a1", "test", "test-model"),
			makeModelChange("a3", "a2", "test/test-model-2", "temporary"),
			makeAssistantEntry("a4", "a3", "test", "test-model-2"),
		];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("test/test-model");
	});

	it("preserves explicit user-selected default when the provider reports a different model id", () => {
		// User picks test-model; the assistant message returned by the upstream
		// provider is tagged "test-model-2" (server-side downgrade /
		// stale id mapping).  Resume must still restore what the user picked.
		const entries: SessionEntry[] = [
			makeModelChange("b1", null, "test/test-model", "default"),
			makeAssistantEntry("b2", "b1", "test", "test-model-2"),
		];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("test/test-model");
	});

	it("still infers default from assistant messages when no model_change entry exists", () => {
		// Backwards compatibility: legacy sessions have no model_change entries
		// and rely on assistant-message inference.
		const entries: SessionEntry[] = [makeAssistantEntry("c1", null, "test", "test-model-2")];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("test/test-model-2");
	});
});
