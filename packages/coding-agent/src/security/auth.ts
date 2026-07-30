import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthStorage } from "../session/auth-storage";
import type { SecurityAccountRef } from "./contracts";

export interface ExactSecurityOAuthOptions {
	authStorage: AuthStorage;
	account: SecurityAccountRef;
}

function assertIdentityMatches(account: SecurityAccountRef, resolvedAccountId: string | undefined): void {
	if (account.accountId !== undefined && account.accountId !== resolvedAccountId) {
		throw new Error(
			`Security scan account mismatch: expected workspace ${account.accountId}, resolved ${resolvedAccountId}`,
		);
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
			throw new Error(
				`Security scan model provider ${model.provider} does not match pinned account provider ${account.provider}`,
			);
		}
		const resolver: ApiKeyResolver = async context => {
			if (context.lastChance) return undefined;
			const resolution = await authStorage.getOAuthAccessByCredentialId(account.provider, account.credentialId, {
				forceRefresh: context.error !== undefined,
				signal: context.signal,
			});
			if (!resolution) {
				throw new Error(`Security scan OAuth credential ${account.credentialId} is unavailable`);
			}
			if (!resolution.ok) {
				throw new Error(
					`Security scan OAuth credential ${account.credentialId} could not be resolved: ${resolution.error}`,
				);
			}
			assertIdentityMatches(account, resolution.accountId);
			return resolution.accessToken;
		};
		return resolver;
	};
}
