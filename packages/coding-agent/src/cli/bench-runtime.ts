/** Shared explicit-model runtime for `omp bench` and `omp if-bench`. */
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { concreteThinkingLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

/** Injection point for the provider call; tests pass a synthetic event stream. */
export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Explicit model configuration and credentials used by a benchmark. */
export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Open the auth vault, settings, and model registry for a benchmark run. */
export async function createDefaultBenchRuntime(): Promise<BenchRuntime> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return { modelRegistry, settings, close: () => authStorage.close() };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

/** Resolve explicitly configured models without discovery or credential-driven redirects. */
export async function resolveBenchTargets(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): Promise<BenchTarget[]> {
	const preferences = getModelMatchPreferences(settings);
	const targets: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			availableModels: modelRegistry.getAll(),
			settings,
			preferences,
		});
		if (result.error || !result.model) {
			errors.push(`${selector}: ${result.error ?? "model not found"}`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`Warning: ${result.warning}`)}\n`);
		targets.push({
			selector,
			model: result.model,
			thinking: resolveThinkingLevelForModel(result.model, concreteThinkingLevel(result.thinkingLevel)),
		});
	}
	if (errors.length > 0)
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	return targets;
}
