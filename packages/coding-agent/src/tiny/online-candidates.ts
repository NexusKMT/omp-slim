import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	formatModelStringWithRouting,
	resolveModelOverride,
	resolveRoleSelection,
} from "../config/model-resolver";
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
 * Order: each requested role's primary, then canonical retry fallback chains
 * traversed transitively (so a hop onto B also consults B's own chain).
 * Disabling model fallback restricts attempts to the first resolvable primary.
 */
export function collectOnlineTinyCandidates(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): OnlineTinyCandidate[] {
	const seen = new Set<string>();
	const out: OnlineTinyCandidate[] = [];
	const add = (role: string, model: Model<Api>): boolean => {
		const key = candidateKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		out.push({ role, model });
		return true;
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
	const registryShim = { getAvailable: () => availableModels };

	type ExpandItem = {
		role: string;
		model: Model<Api>;
		/** Selector used to resolve which chain key applies. */
		selector: string;
		roleHint?: string;
	};
	const queue: ExpandItem[] = primaries.map(({ role, model }) => ({
		role,
		model,
		selector: settings.getModelRole(role) ?? modelKey(model),
		roleHint: role,
	}));
	const expanded = new Set<string>();

	while (queue.length > 0) {
		const { role, model, selector, roleHint } = queue.shift()!;
		const chainKey = resolveRetryFallbackChainKey(context, selector, model, roleHint);
		if (!chainKey) continue;
		// Resolved provider/id is the chain primary: bare/fuzzy role selectors and
		// `@upstream` routing suffixes must not empty the chain or poison wildcards.
		const primarySelector = modelKey(model);
		const expandKey = `${chainKey}\0${candidateKey(model)}`;
		if (expanded.has(expandKey)) continue;
		expanded.add(expandKey);

		for (const candidate of findRetryFallbackCandidates(context, chainKey, primarySelector, model, {
			allowMissingPrimary: true,
		})) {
			// Resolve raw selectors (including `@upstream` / fuzzy) the same way
			// turn-recovery does, instead of exact (provider, id) lookup only.
			const resolved = resolveModelOverride([candidate.raw], registryShim, settings);
			const fallback = resolved.model ?? context.modelLookup.find(candidate.provider, candidate.id);
			if (!fallback) continue;
			if (!add(role, fallback)) continue;
			// After landing on this fallback, consult its own chain key so configs
			// like `tiny: [B]` + `B: [C]` reach C (session recovery does the same).
			queue.push({
				role,
				model: fallback,
				selector: formatModelStringWithRouting(fallback),
			});
		}
	}
	return out;
}
