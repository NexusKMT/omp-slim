import { type Model, resolveModelServiceTier, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { describeModelCompactionPoint } from "../session/model-compaction-threshold";

import { cfgDisabledProviders, cfgModelProviderOrder } from "../config/model-settings";
import { cfgDefaultThinkingLevel, cfgTierOpenai } from "../session/settings";

/**
 * Supply live model-overlay preferences and runtime resolution from the host.
 * @param settings - Settings backing preferences and model performance
 * @param sessionServiceTier - The live session's effective tier for a model
 *   (`/fast`, `/fast ultra`, `/slow`, resumed tiers). Omit only where no session
 *   exists; the configured `tier.*` settings stand in then.
 */
export function createModelBrowserSource(
	settings: Settings,
	sessionServiceTier?: (model: Model) => ServiceTier | undefined,
): ModelHubSource {
	return {
		get revision() {
			return settings.revision;
		},
		get defaultThinkingLevel() {
			return cfgDefaultThinkingLevel.get(settings);
		},
		get modelProviderOrder() {
			return cfgModelProviderOrder.get(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		serviceTierFor: model => {
			const tier = sessionServiceTier
				? sessionServiceTier(model)
				: resolveModelServiceTier(buildServiceTierByFamily(cfgTierOpenai.get(settings)), model);
			// Label only a tier the request carries as `service_tier`: that is what the
			// provider echoes back as the served tier, which keys the perf row.
			return shouldSendServiceTier(tier) ? tier : undefined;
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(settings);
		},
		compactionPointFor: model => describeModelCompactionPoint(settings, model),
	};
}
