import type { AuthStorage, SessionRestrictionLease } from "@oh-my-pi/pi-ai/auth-storage";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Provider id → OAuth identity keys one session may authenticate with; see
 * `AuthStorage.sessions.restrict`. A listed provider uses only those accounts
 * and never an API key; an empty list allows no account.
 */
export type OAuthAccountPools = Readonly<Record<string, readonly string[]>>;

/**
 * Validate the exact-agent `task.agentAccountPools` map (agent name → provider
 * id → identity keys). An absent or empty (`null`) mapping means no pools, and
 * a `null` agent entry clears one inherited from a lower-priority settings
 * layer. Any other malformed level fails settings load: dropping it would
 * silently widen a restricted agent to every account. Both levels are
 * null-prototype maps, so a name such as `__proto__` stays an own entry.
 */
export function validateAgentAccountPools(value: unknown): Record<string, OAuthAccountPools> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new Error(
			`Invalid task.agentAccountPools: expected a map of agent name to provider account pools, got ${Array.isArray(value) ? "an array" : `a ${typeof value}`}.`,
		);
	}
	const pools: Record<string, OAuthAccountPools> = Object.create(null);
	for (const [agentName, providers] of Object.entries(value)) {
		if (providers === null) continue;
		if (!isRecord(providers)) {
			throw new Error(
				`Invalid task.agentAccountPools.${agentName}: expected a map of provider to OAuth identity keys, got ${Array.isArray(providers) ? "an array" : `a ${typeof providers}`}.`,
			);
		}
		const agentPools: Record<string, readonly string[]> = Object.create(null);
		for (const [provider, identityKeys] of Object.entries(providers)) {
			if (
				!Array.isArray(identityKeys) ||
				!identityKeys.every((key): key is string => typeof key === "string" && key.length > 0 && key.trim() === key)
			) {
				throw new Error(
					`Invalid task.agentAccountPools.${agentName}.${provider}: expected a list of OAuth identity keys such as "email:you@example.com|org:<org-id>".`,
				);
			}
			agentPools[provider] = identityKeys;
		}
		pools[agentName] = agentPools;
	}
	return pools;
}

/** Leases of one session's pool restrictions, by provider id; see {@link restrictSessionAccounts}. */
export type SessionAccountLeases = ReadonlyMap<string, SessionRestrictionLease>;

/**
 * Install `pools` as `sessionId`'s OAuth account restrictions and return their
 * leases. Sessions call this for every provider session id they adopt: a fresh
 * or reset id starts unrestricted otherwise.
 */
export function restrictSessionAccounts(
	authStorage: Pick<AuthStorage, "sessions">,
	sessionId: string,
	pools: OAuthAccountPools | undefined,
): SessionAccountLeases | undefined {
	if (!pools) return undefined;
	const leases = new Map<string, SessionRestrictionLease>();
	for (const [provider, identityKeys] of Object.entries(pools)) {
		leases.set(provider, authStorage.sessions.restrict(provider, sessionId, identityKeys));
	}
	return leases;
}

/**
 * Lift the restrictions `leases` installed on `sessionId` once that session has
 * ended. A restriction installed on the same id since, such as a revived
 * session's, stays.
 */
export function releaseSessionAccounts(
	authStorage: Pick<AuthStorage, "sessions">,
	sessionId: string,
	leases: SessionAccountLeases | undefined,
): void {
	if (!leases) return;
	for (const [provider, lease] of leases) {
		authStorage.sessions.unrestrict(provider, sessionId, lease);
	}
}
