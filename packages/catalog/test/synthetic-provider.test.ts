import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { syntheticModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Entries mirror live `https://api.synthetic.new/openai/v1/models` payloads:
 * capabilities in `supported_features`, modalities in `input_modalities`, the
 * output cap in `max_output_length`, the accepted `reasoning_effort` values in
 * `reasoning_parameters.efforts`, and `$`-prefixed per-token prices.
 */
function syntheticModelsFetch(): { calls: string[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request) => {
		calls.push(String(input));
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "syn:large:text",
						object: "model",
						name: "syn:large:text",
						hugging_face_id: "zai-org/GLM-5.2",
						reasoning_parameters: { efforts: ["none", "high", "max"] },
						input_modalities: ["text"],
						context_length: 524288,
						max_output_length: 65536,
						supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
						pricing: {
							prompt: "$0.000001",
							completion: "$0.000003",
							input_cache_reads: "$0.00000016",
							input_cache_writes: "0",
						},
					},
					{
						id: "hf:moonshotai/Kimi-K3",
						object: "model",
						name: "moonshotai/Kimi-K3",
						reasoning_parameters: { efforts: ["low", "high", "max"] },
						input_modalities: ["text", "image"],
						context_length: 524288,
						max_output_length: 65536,
						supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
						pricing: {
							prompt: "$0.000003",
							completion: "$0.000015",
							input_cache_reads: "$0.00000045",
							input_cache_writes: "0",
						},
					},
					{
						id: "hf:example/plain-completions",
						object: "model",
						name: "example/plain-completions",
						input_modalities: ["text"],
						context_length: 131072,
						supported_features: ["json_mode"],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, fetch };
}

describe("Synthetic provider discovery", () => {
	test("reads capabilities from Synthetic's own schema instead of the bundled reference", async () => {
		const { calls, fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual(["https://api.synthetic.new/openai/v1/models"]);

		// `syn:*` router aliases ship a bundled reference baked from the era when
		// this mapper read field names Synthetic never sends: `reasoning: false`,
		// no thinking, `maxTokens: 8192`, zero cost. The advertised metadata wins.
		const large = models?.find(model => model.id === "syn:large:text");
		expect(large).toMatchObject({
			provider: "synthetic",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 524288,
			maxTokens: 65536,
			cost: { input: 1, output: 3, cacheRead: 0.16, cacheWrite: 0 },
		});
		// `none` is the router's thinking-off state, so it backs `minimal`
		// through the wire map rather than becoming a tier of its own.
		expect(large?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.High, Effort.Max],
			effortMap: { minimal: "none" },
		});
		expect(large?.supportsTools).toBeUndefined();
	});

	test("derives reasoning, vision, and output cap for routes with no bundled reference", async () => {
		const { fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const kimi = models?.find(model => model.id === "hf:moonshotai/Kimi-K3");
		expect(kimi).toMatchObject({
			provider: "synthetic",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 524288,
			maxTokens: 65536,
			cost: { input: 3, output: 15, cacheRead: 0.45, cacheWrite: 0 },
		});
		// No `none` tier on this route: the ladder is the advertised one verbatim.
		expect(kimi?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	});

	test("keeps non-reasoning routes non-reasoning and marks missing tool support", async () => {
		const { fetch } = syntheticModelsFetch();
		const models = await syntheticModelManagerOptions({ apiKey: "syn-test-key", fetch }).fetchDynamicModels?.();

		const plain = models?.find(model => model.id === "hf:example/plain-completions");
		expect(plain).toMatchObject({
			provider: "synthetic",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			supportsTools: false,
			// No `max_output_length` and no bundled reference: placeholder cap.
			maxTokens: 8192,
			// No `pricing` block: the reference/default cost survives.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(plain?.thinking).toBeUndefined();
	});

	test("serves no dynamic models without an API key", () => {
		expect(syntheticModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
