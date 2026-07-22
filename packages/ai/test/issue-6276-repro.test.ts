import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface GuardrailPayload {
	guardrailConfig?: {
		guardrailIdentifier: string;
		guardrailVersion: string;
		trace?: "enabled" | "disabled" | "enabled_full";
	};
}

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "openai.gpt-oss-20b-1:0",
		name: "gpt-oss-20b",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4_096,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "Reply briefly", timestamp: 0 }],
	tools: [],
};

function capturePayload(options: {
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}): Promise<GuardrailPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<GuardrailPayload>();
	void streamBedrock(model(), context, {
		...options,
		signal: controller.signal,
		onPayload: payload => {
			resolve(payload as GuardrailPayload);
			return undefined;
		},
	});
	return promise;
}

describe("issue #6276 — Amazon Bedrock guardrails", () => {
	it("sends configured guardrail values in the Converse request", async () => {
		const payload = await capturePayload({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			trace: "enabled_full",
		});
	});

	it("defaults configured guardrails to the DRAFT version", async () => {
		const payload = await capturePayload({ guardrailIdentifier: "abcd1234" });

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "abcd1234",
			guardrailVersion: "DRAFT",
			trace: undefined,
		});
	});
});
