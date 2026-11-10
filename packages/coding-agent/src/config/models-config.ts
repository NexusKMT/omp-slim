import { buildModel, requireChatCompletionsApi } from "@oh-my-pi/pi-catalog/build";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { ConfigFile } from "./config-file";
import type { ModelsConfig, ProviderAuthMode } from "./models-config-schema";
import { getModelsConfigSchema } from "./models-config-schema-bundle";

export type ProviderValidationMode = "models-config" | "runtime-register";
export interface ProviderValidationModel extends Partial<ModelSpec<Api>> {
	id: string;
}
export interface ProviderValidationConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	auth?: ProviderAuthMode;
	headers?: Record<string, string>;
	compat?: ModelSpec["compat"];
	models: readonly ProviderValidationModel[];
}

/** Validate the same endpoint contract for YAML and extension-supplied manual models. */
export function validateProviderConfiguration(
	provider: string,
	config: ProviderValidationConfig,
	_mode: ProviderValidationMode,
): void {
	requireChatCompletionsApi(config.api);
	if (!config.baseUrl) throw new Error(`Provider ${provider}: "baseUrl" is required.`);
	if (config.models.length === 0) throw new Error(`Provider ${provider}: at least one explicit model id is required.`);
	if (config.apiKey !== undefined && !config.apiKey.trim())
		throw new Error(`Provider ${provider}: "apiKey" cannot be empty.`);
	const ids = new Set<string>();
	for (const model of config.models) {
		if (ids.has(model.id)) throw new Error(`Provider ${provider}: duplicate model id "${model.id}".`);
		ids.add(model.id);
		buildModel({ ...model, provider, api: model.api ?? config.api, baseUrl: model.baseUrl ?? config.baseUrl });
	}
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", {
	kind: "deferred",
	resolve: getModelsConfigSchema,
}).withValidation("models", config => {
	for (const [provider, definition] of Object.entries(config.providers ?? {})) {
		validateProviderConfiguration(provider, definition, "models-config");
	}
});
