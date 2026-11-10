import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { Settings } from "../config/settings";
import { cfgEditMode, type EditModeSetting, editModelVariants } from "../edit/settings";

/** First `edit.modelVariants` entry whose pattern occurs in `model` (case-insensitive). */
export function editVariantForModel(settings: Settings, model: string | undefined): EditMode | undefined {
	if (!model) return undefined;
	const modelLower = model.toLowerCase();
	return editModelVariants.get(settings).find(variant => modelLower.includes(variant.patternLower))?.mode;
}

export interface EditModeSessionLike {
	settings: Settings;
	getActiveModelString?: () => string | undefined;
}

/**
 * Edit tool variant for the active model, or `"none"` when `edit.mode` removes the tool.
 * `"none"` wins over `edit.modelVariants`: tool registration follows the setting, not the model.
 */
export function resolveEditMode(session: EditModeSessionLike): EditModeSetting {
	const mode = cfgEditMode.get(session.settings);
	if (mode === "none") return mode;

	const activeModel = session.getActiveModelString?.();
	const modelVariant = editVariantForModel(session.settings, activeModel);
	if (modelVariant) return modelVariant;
	return mode;
}
