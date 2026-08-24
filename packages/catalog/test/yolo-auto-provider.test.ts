import { describe, expect, test } from "bun:test";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { yoloAutoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Fixture mirrors the live `https://yolo-auto.com/v1/models` surface: an
 * OpenAI-style `data` array of public model ids. The docs only advertise
 * `qwen3.8-27b`; the extra id proves discovery surfaces whatever the wire
 * returns, not just bundled ids.
 */
function yoloAutoModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [
					{ id: "qwen3.8-27b", object: "model", created: 0, owned_by: "yolo-auto" },
					{ id: "qwen3.8-27b:beta", object: "model", created: 0, owned_by: "yolo-auto" },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("Yolo-Auto provider discovery", () => {
	test("discovers /v1/models with the bundled reference's reasoning, vision, and compat", async () => {
		const { calls, authorizations, fetch } = yoloAutoModelsFetch();
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual(["https://yolo-auto.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer yolo-test-key"]);

		const qwen = models?.find(model => model.id === "qwen3.8-27b");
		expect(qwen).toMatchObject({
			provider: "yolo-auto",
			api: "openai-completions",
			baseUrl: "https://yolo-auto.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			// Canonical qwen family cap, baked into the bundled reference by
			// the generator and inherited when the wire omits max output.
			maxTokens: 32768,
		});
		// The documented wire surface flows from the bundled reference into
		// discovered models: Qwen chat-template dialect, effort steering, and
		// no developer role / store param.
		expect(qwen?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "qwen-chat-template",
		});
		expect(qwen?.thinking?.mode).toBe("effort");
	});

	test("surfaces wire ids that have no bundled reference", async () => {
		const { fetch } = yoloAutoModelsFetch();
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		expect(models?.some(model => model.id === "qwen3.8-27b:beta")).toBe(true);
	});

	test("returns null when /v1/models rejects the key", async () => {
		const fetch: FetchImpl = async () => new Response("Unauthorized", { status: 401 });
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-bogus", fetch }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});

	test("serves no dynamic models without an API key", () => {
		expect(yoloAutoModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("marks live discovery authoritative so retired bundled ids cannot linger", () => {
		// The runtime merge path reads this flag from the manager options, not
		// the catalog descriptor — without it a successful /v1/models response
		// merges over the bundled seed instead of replacing it.
		expect(yoloAutoModelManagerOptions({ apiKey: "yolo-test-key" }).dynamicModelsAuthoritative).toBe(true);
	});

	test("prunes the bundled id when a live catalog omits it", async () => {
		// Regression: a provider-side retirement of qwen3.8-27b must not leave
		// the bundled seed selectable. With the authoritative option the
		// production manager replaces the static rows with the wire catalog.
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: "live-only", object: "model" }] }), { status: 200 });
		const manager = createModelManager(yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }));
		const { models } = await manager.refresh("online");

		expect(models.map(model => model.id)).toEqual(["live-only"]);
	});
});
