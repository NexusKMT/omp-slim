import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "./model-registry";
import { pickDefaultAvailableModel, resolveCliModel } from "./model-resolver";
import { Settings } from "./settings";
import { resolveConfigValue } from "./resolve-config-value";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";

export interface ConfiguredModel {
	model: Model;
	apiKey: string;
}

/** Resolve local tools through the CLI's local model and API-key configuration. */
export async function resolveConfiguredModel(
	modelSpec?: string,
	{ cwd = process.cwd(), agentDir = getAgentDir() }: { cwd?: string; agentDir?: string } = {},
): Promise<ConfiguredModel> {
	const settings = await Settings.loadReadOnly({ cwd, agentDir });
	const storage = await AuthStorage.create(getAgentDbPath(agentDir), { configValueResolver: resolveConfigValue });
	try {
		const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
		const configError = registry.getError();
		if (configError) throw configError;
		const selector = modelSpec ?? settings.getModel();
		const resolved = resolveCliModel({ cliModel: selector, modelRegistry: registry, settings });
		if (resolved.error) throw new Error(resolved.error);
		const model = resolved.model ?? pickDefaultAvailableModel(registry.getAvailable());
		if (!model) throw new Error("No chat model configured. Configure an endpoint and model in models.yml.");
		const apiKey = await registry.getApiKey(model);
		if (apiKey === undefined) throw new Error(`No API key configured for "${model.provider}".`);
		return { model, apiKey };
	} finally {
		storage.close();
	}
}
