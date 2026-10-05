import { realizesPriorityServiceTier, resolveModelServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings } from "../config/settings";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
} from "../session/settings";

/** Supply live model-overlay preferences and runtime resolution from the host. */
export function createModelBrowserSource(settings: Settings): ModelHubSource {
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
		get knownRoleIds() {
			return getKnownRoleIds(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		serviceTierFor: model => {
			const tier = resolveModelServiceTier(
				buildServiceTierByFamily(
					cfgTierOpenai.get(settings),
					cfgTierAnthropic.get(settings),
					cfgTierGoogle.get(settings),
				),
				model,
			);
			// The browser must show the tier the request would actually carry. Priority
			// realizes through Anthropic's fast mode or the provider's tier gate; the
			// other tiers go through the wire gate alone.
			if (!tier) return undefined;
			const realized =
				tier === "priority" ? realizesPriorityServiceTier(tier, model) : shouldSendServiceTier(tier, model);
			return realized ? tier : undefined;
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(settings);
		},
		get fallbackChains() {
			return cfgRetryFallbackChains.get(settings);
		},
		get modelRoleStorage() {
			return cfgModelRoleStorage.get(settings);
		},
		get cycleOrder() {
			return cfgCycleOrder.get(settings);
		},
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
		getModelPresets: () => ({ names: getModelPresetNames(settings), active: findActiveModelPreset(settings) }),
	};
}
