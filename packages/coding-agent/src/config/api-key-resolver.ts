import type { ApiKeyResolution, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthApiKeyOptions } from "@oh-my-pi/pi-ai/auth-storage";
import type { Model } from "@oh-my-pi/pi-catalog/types";

export type ApiKeyResolverModel = Pick<Model, "provider" | "baseUrl" | "id">;
export interface ApiKeyResolverOptions {
	sessionId?: string;
	baseUrl?: string;
	modelId?: string;
}
export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
	getApiKeyWithCredentialForProvider(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ApiKeyResolution>;
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
}

/** Resolve only the selected endpoint's key. Authentication failures never rotate accounts. */
export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyWithCredentialForProvider">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	return ({ error, signal }) =>
		error !== undefined
			? undefined
			: registry.getApiKeyWithCredentialForProvider(provider, options.sessionId, {
					baseUrl: options.baseUrl,
					modelId: options.modelId,
					signal,
				});
}
