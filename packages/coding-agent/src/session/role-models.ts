import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";

/** Formats a role assignment while preserving its explicit thinking selector. */
export function formatRoleModelValue(
	settings: Settings,
	modelRegistry: ModelRegistry,
	_role: string,
	model: Model,
	selectorOverride?: string,
	thinkingLevelOverride?: ConfiguredThinkingLevel,
): string {
	const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
	if (thinkingLevelOverride !== undefined) return formatModelSelectorValue(modelKey, thinkingLevelOverride);
	const existingRoleValue = settings.getModel();
	if (!existingRoleValue) return modelKey;
	const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, settings, {
		isLiteralModelId: (provider, id) => {
			if (provider !== undefined) return modelRegistry.find(provider, id) !== undefined;
			const lowerId = id.toLowerCase();
			return modelRegistry.getAll("all").some(candidate => candidate.id.toLowerCase() === lowerId);
		},
	});
	return formatModelSelectorValue(modelKey, thinkingLevel);
}

/** Resolves a model role and its explicit thinking selection. */
export function resolveRoleModelFull(
	settings: Settings,
	_role: string,
	availableModels: Model[],
	currentModel: Model | undefined,
): ResolvedModelRoleValue {
	if (currentModel) {
		return { model: currentModel, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}
	return resolveModelRoleValue(settings.getModel(), availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
}
