import type { Model } from "../types";
import { isCatalogEndpointUrl } from "./catalog-endpoint";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Standard Responses transport preference within the rule-owned provider/API
 * scope. Explicit request and model preferences can opt a gateway in, but never
 * enable a provider without a true catalog rule. Unspecified preferences use
 * WebSockets only at the provider's own catalog endpoint.
 */
export function resolveResponsesWebSocketPreference(model: Model, requestPreference?: boolean): boolean {
	if (resolveCatalogPolicy(model).preferWebsockets !== true) return false;
	return requestPreference ?? model.preferWebsockets ?? isCatalogEndpointUrl(model, model.baseUrl);
}
