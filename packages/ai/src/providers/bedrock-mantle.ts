import { $env } from "@oh-my-pi/pi-utils";
import { AUTHENTICATED_SENTINEL } from "../registry/types";
import type { FetchImpl, Model } from "../types";
import { resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";
import type { OpenAIResponsesOptions } from "./openai-responses";

export interface BedrockMantleOptions extends OpenAIResponsesOptions {
	region?: string;
	profile?: string;
	/** Amazon Bedrock API key sent as a bearer token, ahead of SigV4 credential resolution. */
	bearerToken?: string;
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
	if (init?.body !== undefined && init.body !== null) {
		if (typeof init.body === "string") return new TextEncoder().encode(init.body);
		if (init.body instanceof Uint8Array) return init.body;
		if (init.body instanceof ArrayBuffer) return new Uint8Array(init.body);
		throw new TypeError(`Cannot SigV4-sign ${init.body.constructor?.name ?? typeof init.body} request body`);
	}
	if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
	return new Uint8Array();
}

function createSignedFetch(options: BedrockMantleOptions, region: string): FetchImpl {
	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const signedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "POST");
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.delete("authorization");
		const body = await requestBody(input, init);
		const credentials = await resolveAwsCredentials({
			profile: options.profile,
			region,
			signal: options.signal,
			fetch: baseFetch,
		});
		const signed = await signRequest({
			method,
			host: url.host,
			path: url.pathname,
			query: url.search.slice(1),
			body,
			region,
			service: "bedrock-mantle",
			credentials,
			headers: { "content-type": headers.get("content-type") ?? "application/json" },
		});
		for (const [name, value] of Object.entries(signed)) {
			if (value !== undefined && name !== "host") headers.set(name, value);
		}
		return baseFetch(url, { ...init, method, headers, body });
	};
	return Object.assign(signedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

export interface PreparedBedrockMantleRequest {
	model: Model<"openai-responses">;
	options: OpenAIResponsesOptions;
}

export function prepareBedrockMantleRequest(
	model: Model<"openai-responses">,
	options: BedrockMantleOptions,
): PreparedBedrockMantleRequest {
	const region = options.region || $env.AWS_REGION || $env.AWS_DEFAULT_REGION || "us-east-1";
	const resolvedModel = { ...model, baseUrl: model.baseUrl.replaceAll("{region}", encodeURIComponent(region)) };
	const apiKey = options.apiKey === AUTHENTICATED_SENTINEL || options.apiKey === "N/A" ? undefined : options.apiKey;
	const bearerToken = options.bearerToken || apiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
	if (bearerToken) {
		return { model: resolvedModel, options: { ...options, apiKey: bearerToken } };
	}
	return {
		model: resolvedModel,
		options: {
			...options,
			apiKey: "N/A",
			fetch: createSignedFetch(options, region),
		},
	};
}
