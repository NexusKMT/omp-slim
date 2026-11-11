import { isDefinitiveOAuthFailure } from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials } from "./oauth-types";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { MCPOAuthStorage } from "./oauth-storage";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
	refreshMCPOAuthToken,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		const id = mcpOAuthCredentialId(url);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	oauthStorage: MCPOAuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!oauthStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = oauthStorage.get(auth.credentialId);
		if (credential?.type === "oauth") {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = oauthStorage.get(credentialId);
		if (credential?.type === "oauth") {
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	oauthStorage: MCPOAuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(oauthStorage, auth, undefined);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(oauthStorage, auth, config.url, { allowUrlKeyedFallback: false });
	}
	return lookupMcpOAuthCredentialForServer(oauthStorage, auth, config.url);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

/**
 * Refresh a stored MCP OAuth credential via the standard `refresh_token` grant.
 *
 * Refresh material is taken from the credential itself (self-contained modern
 * credentials embed `tokenUrl`/`clientId`/`clientSecret`/`resource`) or, for
 * legacy credentials that carry none, the server's `auth` block.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator when neither
 * the credential nor the auth block advertised one; the manager passes the
 * configured server URL.
 *
 * @throws when no usable refresh token or token endpoint is available.
 */
export function refreshManagedMcpOAuthCredential(
	credential: MCPStoredOAuthCredential,
	opts: { serverUrl?: string; auth?: MCPAuthConfig; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const material = selectMcpOAuthRefreshMaterial(credential, opts.auth);
	const tokenUrl = material?.tokenUrl;
	if (!credential.refresh || !tokenUrl) {
		throw new Error("MCP OAuth credential is missing refresh material");
	}
	const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
	const resourceIsFallback = !material?.resource && Boolean(opts.serverUrl);
	const resource = material?.resource ?? (resourceIsFallback ? opts.serverUrl : undefined);
	return refreshMCPOAuthToken(tokenUrl, credential.refresh, material?.clientId, material?.clientSecret, resource, {
		authorizationUrl,
		stripSameOriginResource: resourceIsFallback,
		signal: opts.signal,
	});
}

export interface StoredMcpOAuthRefreshResult {
	credential: MCPStoredOAuthCredential | undefined;
	refreshed: boolean;
	removed: boolean;
}

/** Serialize rotating refresh grants across processes and persist before returning the token. */
export async function refreshStoredManagedMcpOAuthCredential(
	oauthStorage: MCPOAuthStorage,
	credentialId: string,
	opts: {
		serverUrl?: string;
		auth?: MCPAuthConfig;
		forceRefresh?: boolean;
		keepCredentialOnRefreshFailure?: boolean;
		onRefreshFailure?: (error: unknown) => void;
	} = {},
): Promise<StoredMcpOAuthRefreshResult> {
	const observed = oauthStorage.get(credentialId);
	const result = (
		credential: MCPStoredOAuthCredential | undefined,
		refreshed = false,
		removed = false,
	): StoredMcpOAuthRefreshResult => ({ credential, refreshed, removed });
	if (!observed) return result(undefined);
	const fresh = (credential: MCPStoredOAuthCredential): boolean => credential.expires > Date.now() + 5 * 60_000;
	if (!opts.forceRefresh && fresh(observed)) return result(observed);
	return oauthStorage.withRefreshLock(credentialId, async () => {
		const current = oauthStorage.get(credentialId);
		if (!current) return result(undefined);
		// A peer already refreshed (or the user logged in) while this caller waited.
		if ((!opts.forceRefresh || !Bun.deepEquals(current, observed)) && fresh(current)) return result(current);
		const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
		if (!current.refresh || !material?.tokenUrl) return result(current);
		try {
			const refreshed = await refreshManagedMcpOAuthCredential(current, {
				serverUrl: opts.serverUrl,
				auth: opts.auth,
				signal: AbortSignal.timeout(30_000),
			});
			const next: MCPStoredOAuthCredential = {
				...current,
				...refreshed,
				tokenUrl: material.tokenUrl,
				clientId: material.clientId,
				clientSecret: material.clientSecret,
				resource: material.resource,
				authorizationUrl: "authorizationUrl" in material ? material.authorizationUrl : undefined,
			};
			if (!oauthStorage.replaceIfUnchanged(credentialId, current, next))
				return result(oauthStorage.get(credentialId));
			return result(next, true);
		} catch (error) {
			const latest = oauthStorage.get(credentialId);
			if (!Bun.deepEquals(latest, current)) return result(latest);
			if (isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error))) {
				const removed = oauthStorage.replaceIfUnchanged(credentialId, current, undefined);
				return result(oauthStorage.get(credentialId), false, removed);
			}
			opts.onRefreshFailure?.(error);
			if (opts.keepCredentialOnRefreshFailure === false) throw error;
			return result(latest);
		}
	});
}

export async function removeManagedMcpOAuthCredential(
	oauthStorage: MCPOAuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (oauthStorage.get(credentialId)?.type !== "oauth") return false;
	await oauthStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	oauthStorage: MCPOAuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(oauthStorage, credentialId)) || removed;
	}
	return removed;
}
