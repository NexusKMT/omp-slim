import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Model } from "../types";

const DEFAULT_AZURE_API_VERSION = "v1";

/** Request options that pick an Azure OpenAI endpoint. */
export interface AzureEndpointOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
}

/**
 * Endpoint and API version an Azure OpenAI Responses request goes to: the
 * explicit option, then `AZURE_OPENAI_BASE_URL`, then the resource name, then
 * the model's `baseUrl`. Throws when none is set.
 */
export function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureEndpointOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || $env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new AIError.ConfigurationError(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
		apiVersion,
	};
}
