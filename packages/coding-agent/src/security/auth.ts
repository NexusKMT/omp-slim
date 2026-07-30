import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthStorage } from "../session/auth-storage";
import type { SecurityAccountRef } from "./contracts";

export interface ExactSecurityOAuthOptions {
	authStorage: AuthStorage;
	account: SecurityAccountRef;
}

function assertIdentityMatches(
	account: SecurityAccountRef,
	resolution: {
		credentialId?: number;
		accountId?: string;
		email?: string;
		orgId?: string;
		orgName?: string;
	},
): void {
	if (
		account.credentialId !== resolution.credentialId ||
		(account.accountId !== undefined && account.accountId !== resolution.accountId) ||
		(account.email !== undefined && account.email !== resolution.email) ||
		(account.organizationId !== undefined && account.organizationId !== resolution.orgId) ||
		(account.organizationName !== undefined && account.organizationName !== resolution.orgName)
	) {
		throw new Error("Security scan authentication identity mismatch");
	}
}

/**
 * Build a request credential resolver pinned to one durable OAuth row.
 *
 * Initial resolution and refresh both target the same row. The auth driver's
 * final sibling-rotation step returns `undefined`, so an unavailable account
 * fails the scan rather than crossing an account/workspace boundary.
 */
export function createExactSecurityOAuthResolver(
	options: ExactSecurityOAuthOptions,
): NonNullable<AgentOptions["getApiKey"]> {
	const { account, authStorage } = options;
	return model => {
		if (model.provider !== account.provider) {
			throw new Error("Security scan authentication provider mismatch");
		}
		const resolver: ApiKeyResolver = async context => {
			if (context.lastChance) return undefined;
			const resolution = await authStorage.getOAuthAccessByCredentialId(account.provider, account.credentialId, {
				forceRefresh: context.error !== undefined,
				signal: context.signal,
			});
			if (!resolution) {
				throw new Error("The pinned security OAuth credential is unavailable");
			}
			assertIdentityMatches(account, resolution);
			if (!resolution.ok) {
				throw new Error("The pinned security OAuth credential could not be resolved");
			}
			return resolution.accessToken;
		};
		return resolver;
	};
}
