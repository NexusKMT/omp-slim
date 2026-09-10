import type { Api, Model } from "@oh-my-pi/pi-ai";
import { formatModelStringWithRouting, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";

/** Role-resolved model used by online tiny tasks (auto-thinking, titles). */
export interface OnlineTinyCandidate {
	role: string;
	model: Model<Api>;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Dedup key that keeps distinct `@upstream` routes as separate candidates. */
function candidateKey(model: Model<Api>): string {
	return formatModelStringWithRouting(model);
}

/**
 * Collect unique online models for lightweight background tasks.
 *
 * Order: each requested role's primary, then its canonical retry fallback chain.
 * Disabling model fallback restricts attempts to the first resolvable primary.
 */
export function collectOnlineTinyCandidates(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): OnlineTinyCandidate[] {
	const seen = new Set<string>();
	const out: OnlineTinyCandidate[] = [];
	const add = (role: string, model: Model<Api>) => {
		const key = candidateKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ role, model });
	};

	// Retain every role even if primaries coincide: their fallback chains can differ.
	const primaries: OnlineTinyCandidate[] = [];
	for (const role of roles) {
		const resolved = resolveRoleSelection([role], settings, availableModels);
		if (!resolved?.model) continue;
		add(resolved.role, resolved.model);
		if (settings.get("retry.modelFallback") === false) return out;
		primaries.push({ role: resolved.role, model: resolved.model });
	}

	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return out;
	const context: RetryFallbackResolutionContext = {
		chains: expandDefaultRetryFallbackChains(configuredChains, roles),
		getModelRole: role => settings.getModelRole(role),
		modelLookup: {
			find: (provider, id) => availableModels.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => availableModels.some(model => model.provider === provider),
		},
	};
	for (const { role, model } of primaries) {
		const configuredSelector = settings.getModelRole(role) ?? modelKey(model);
		const chainKey = resolveRetryFallbackChainKey(context, configuredSelector, model, role);
		if (!chainKey) continue;
		// Resolved provider/id is the chain primary: bare/fuzzy role selectors and
		// `@upstream` routing suffixes must not empty the chain or poison wildcards.
		const primarySelector = modelKey(model);
		for (const candidate of findRetryFallbackCandidates(context, chainKey, primarySelector, model, {
			allowMissingPrimary: true,
		})) {
			const fallback = context.modelLookup.find(candidate.provider, candidate.id);
			if (fallback) add(role, fallback);
		}
	}
	return out;
}
