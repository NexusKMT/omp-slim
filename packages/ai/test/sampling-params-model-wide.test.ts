import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Whether a model accepts `temperature`/`top_p` is a property of the model, not
// of the provider serving it: GPT-5+/GPT-6 and adaptive Claude reject them with
// a 400 on Bedrock, OpenRouter, and every other host. Before the central gate,
// only the OpenAI- and Anthropic-shaped providers checked, so the same models
// on Bedrock or OpenRouter still sent them.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function bundled<TApi extends Api>(provider: Parameters<typeof getBundledModel>[0], id: string): Model<TApi> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model as Model<TApi>;
}

const emptyResponse = async () => new Response(new Uint8Array(), { status: 200 });

/** The body as sent: providers may build `temperature: undefined`, which serialization drops. */
const wire = (payload: unknown) => JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

function simplePayload(model: Model<Api>): Promise<Record<string, unknown>> {
	setBedrockProviderModule({ streamBedrock });
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		providerOptions: { bearerToken: "test-token" },
		maxTokens: 16,
		temperature: 0,
		topP: 0.9,
		fetch: emptyResponse,
		onPayload: payload => resolve(wire(payload)),
	});
	return promise;
}

function bedrockInference(payload: Record<string, unknown>): Record<string, unknown> {
	return (payload.inferenceConfig ?? {}) as Record<string, unknown>;
}

describe("sampling params are gated by model, on every provider", () => {
	test.each([["global.openai.gpt-6-luna"], ["global.anthropic.claude-opus-5-5"]])(
		"Bedrock %s omits temperature and topP",
		async id => {
			const inference = bedrockInference(await simplePayload(bundled("amazon-bedrock", id)));
			expect(inference).not.toHaveProperty("temperature");
			expect(inference).not.toHaveProperty("topP");
			expect(inference.maxTokens).toBe(16);
		},
	);

	test("Bedrock Claude Sonnet 4.5 still sends temperature and topP", async () => {
		const inference = bedrockInference(
			await simplePayload(bundled("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")),
		);
		expect(inference.temperature).toBe(0);
		expect(inference.topP).toBe(0.9);
	});

	test("OpenRouter Claude Opus 5.5 omits temperature despite route compat allowing it", async () => {
		const model = bundled<"openrouter">("openrouter", "anthropic/claude-opus-5.5");
		expect(model.compat.supportsSamplingParams).toBe(true);
		const payload = await simplePayload(model);
		expect(payload).not.toHaveProperty("temperature");
		expect(payload).not.toHaveProperty("top_p");
	});

	test("OpenRouter Claude Sonnet 4.5 still sends temperature", async () => {
		const payload = await simplePayload(bundled("openrouter", "anthropic/claude-sonnet-4.5"));
		expect(payload.temperature).toBe(0);
	});

	test("the non-simple stream() entry applies the same gate", async () => {
		setBedrockProviderModule({ streamBedrock });
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		void stream(bundled<"bedrock-converse-stream">("amazon-bedrock", "global.openai.gpt-6-luna"), context, {
			bearerToken: "test-token",
			maxTokens: 16,
			temperature: 0,
			fetch: emptyResponse,
			onPayload: payload => resolve(wire(payload)),
		});
		expect(bedrockInference(await promise)).not.toHaveProperty("temperature");
	});
});
