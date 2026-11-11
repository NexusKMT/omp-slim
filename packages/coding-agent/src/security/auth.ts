import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { SecurityAuthRef } from "./contracts";

export interface SecurityAuthModel {
	provider: string;
	api: string;
}
export interface SecurityAuthResolverOptions {
	auth: SecurityAuthRef;
	providerResolver: NonNullable<AgentOptions["getApiKey"]>;
}

/** Bind a local scan to the explicitly configured Chat endpoint. */
export function selectSecurityAuth(model: SecurityAuthModel): SecurityAuthRef {
	if (model.api !== "openai-completions")
		throw new Error("Security scans require a configured Chat Completions model");
	return { provider: model.provider, api: model.api };
}

/** A resumed scan cannot silently move to another endpoint or revive a retired OAuth identity. */
export function createSecurityAuthResolver(
	options: SecurityAuthResolverOptions,
): NonNullable<AgentOptions["getApiKey"]> {
	const { auth, providerResolver } = options;
	if ("credentialId" in auth)
		throw new Error("This scan used a retired provider login; create a new scan with your configured API key");
	return model => {
		if (model.provider !== auth.provider || model.api !== auth.api)
			throw new Error("Security scan authentication endpoint mismatch");
		return providerResolver(model);
	};
}
