import { describe, expect, test } from "bun:test";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { BedrockMantleOptions } from "@oh-my-pi/pi-ai/providers/bedrock-mantle";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv } from "./helpers";

const mantleModel: Model<"openai-responses"> = buildModel({
	id: "openai.gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
	contextWindow: 272_000,
	maxTokens: 128_000,
});

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
const cleanAwsEnv = {
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_REGION: undefined,
	AWS_DEFAULT_REGION: undefined,
	AWS_EC2_METADATA_DISABLED: "true",
};

interface Capture {
	url?: string;
	authorization?: string | null;
	securityToken?: string | null;
}

function captureFetch(capture: Capture): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			capture.url = String(input instanceof Request ? input.url : input);
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			capture.authorization = headers.get("authorization");
			capture.securityToken = headers.get("x-amz-security-token");
			return new Response("captured", { status: 418 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function runDirect(
	env: Record<string, string | undefined>,
	options: BedrockMantleOptions = {},
): Promise<Capture> {
	const capture: Capture = {};
	await withEnv({ ...cleanAwsEnv, ...env }, async () => {
		clearAwsCredentialCache();
		await stream(mantleModel, context, { ...options, fetch: captureFetch(capture), maxTokens: 16 }).result();
	});
	return capture;
}

describe("Bedrock Mantle authentication", () => {
	test("uses the configured region and Bedrock bearer token", async () => {
		const capture = await runDirect({
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_REGION: "us-east-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toBe("Bearer test-token");
	});

	test("SigV4-signs with the standard AWS credential chain", async () => {
		const capture = await runDirect({
			AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
			AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			AWS_SESSION_TOKEN: "test-session-token",
			AWS_REGION: "us-west-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(capture.securityToken).toBe("test-session-token");
	});

	test("streamSimple preserves AWS options and resolver-supplied keys", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		const options: SimpleStreamOptions = {
			apiKey: async () => {
				resolverCalls++;
				return "resolved-token";
			},
			region: "us-east-2",
			profile: "ignored-for-bearer",
			fetch: captureFetch(capture),
			maxTokens: 16,
		};
		await withEnv(cleanAwsEnv, async () => {
			await streamSimple(mantleModel, context, options).result();
		});
		expect(resolverCalls).toBe(1);
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
		expect(capture.authorization).toBe("Bearer resolved-token");
	});

	test("streamSimple falls back to SigV4 when its optional key resolver is empty", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				AWS_REGION: "us-east-2",
			},
			async () => {
				await streamSimple(mantleModel, context, {
					apiKey: async () => {
						resolverCalls++;
						return undefined;
					},
					fetch: captureFetch(capture),
					maxTokens: 16,
				}).result();
			},
		);
		expect(resolverCalls).toBe(1);
		expect(capture.authorization).toContain("/us-east-2/bedrock-mantle/aws4_request");
	});

	test("pi-native transport wins over local Mantle authentication", async () => {
		const capture: Capture = {};
		const gatewayModel = {
			...mantleModel,
			baseUrl: "http://gateway.internal",
			transport: "pi-native" as const,
		};
		await expect(
			streamSimple(gatewayModel, context, {
				apiKey: "gateway-token",
				fetch: captureFetch(capture),
				maxTokens: 16,
			}).result(),
		).rejects.toThrow("auth-gateway 418");
		expect(capture.url).toBe("http://gateway.internal/v1/pi/stream");
	});
});
