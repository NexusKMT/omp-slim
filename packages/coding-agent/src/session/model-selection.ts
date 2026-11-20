import type { Model } from "@oh-my-pi/pi-ai";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { extractExplicitThinkingSelector } from "../config/model-resolver";
import type { Settings } from "../config/settings";

/** Formats the selected model while preserving its explicit thinking selector. */
export function formatSelectedModelValue(
	settings: Settings,
	modelRegistry: ModelRegistry,
	model: Model,
	selectorOverride?: string,
	thinkingLevelOverride?: ConfiguredThinkingLevel,
): string {
	const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
	if (thinkingLevelOverride !== undefined) return formatModelSelectorValue(modelKey, thinkingLevelOverride);
	const existingModelValue = settings.getModel();
	if (!existingModelValue) return modelKey;
	const thinkingLevel = extractExplicitThinkingSelector(existingModelValue, settings, {
		isLiteralModelId: (provider, id) => {
			if (provider !== undefined) return modelRegistry.find(provider, id) !== undefined;
			const lowerId = id.toLowerCase();
			return modelRegistry.getAll("all").some(candidate => candidate.id.toLowerCase() === lowerId);
		},
	});
	return formatModelSelectorValue(modelKey, thinkingLevel);
}
