import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { createConfigHeaderResolver } from "./resolve-config-value";
import type { ProviderValidationConfig } from "./models-config";

export interface ManualProviderConfig extends ProviderValidationConfig {
	baseUrl: string;
	authHeader?: boolean;
}

/** Compose configured provider defaults and one explicitly named model. */
export function buildCustomModels(provider: string, config: ManualProviderConfig): Model[] {
	return config.models.map(definition => {
		const spec: ModelSpec = {
			...definition,
			provider,
			api: definition.api ?? config.api,
			baseUrl: definition.baseUrl ?? config.baseUrl,
			compat: { ...config.compat, ...definition.compat },
			resolveHeaders: createConfigHeaderResolver([config.headers, definition.headers], {
				authHeader: config.authHeader,
				apiKeyConfig: config.apiKey,
			}),
		};
		return buildModel(spec);
	});
}
