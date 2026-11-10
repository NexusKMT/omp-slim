import * as path from "node:path";
import type { ApiKeyResolver, ResolvedApiKey } from "@oh-my-pi/pi-ai";
import type { AuthApiKeyOptions } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, Model, ModelKind, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../session/auth-storage";
import {
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
	cfgExtendedContext,
} from "../session/context-settings";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import type { ConfigError, ConfigFile } from "./config-file";
import { matchModelCompactionThreshold } from "./compaction-threshold";
import { buildCustomModels, type ManualProviderConfig } from "./custom-models";
import { cfgDisabledProviders } from "./model-settings";
import { ModelsConfigFile, validateProviderConfiguration } from "./models-config";
import type { ModelsConfig } from "./models-config-schema";
import {
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	isCommandConfigValue,
	createConfigHeaderResolver,
	resolveConfigValue,
} from "./resolve-config-value";
import { type Settings, settings } from "./settings";

export const kNoAuth = "N/A";
export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

/** Kept for callers which request a refresh; every refresh now reads only local configuration. */
export type ModelRefreshStrategy = "offline" | "online" | "online-if-uncached";
export interface ModelRegistryRefreshOptions {
	refreshCommandCredentials?: boolean;
}
export interface ContextWindowTiers {
	standard: number;
	extended: number;
}
export type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };

/** Extensions may register explicit Chat Completions endpoints, not transport implementations. */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	auth?: "apiKey" | "none";
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: ModelSpec["compat"];
	models?: Array<Partial<Omit<ModelSpec, "provider">> & { id: string }>;
}

export interface ModelRegistryOwner {
	invalidateCommandConfigs(provider?: string): void;
	refresh(strategy?: ModelRefreshStrategy, options?: ModelRegistryRefreshOptions): Promise<void>;
	refreshIfStale(): Promise<boolean>;
}
export interface ModelRegistryMirrorInputs {
	readonly modelsPath: string | undefined;
	readonly settings: Settings | undefined;
}
type ModelRegistryMirrorChangeInput =
	| {
			readonly kind: "register";
			readonly name: string;
			readonly config: ProviderConfigInput;
			readonly sourceId: string | undefined;
	  }
	| { readonly kind: "unregister"; readonly name: string }
	| { readonly kind: "clearSources"; readonly sourceIds: readonly string[] }
	| { readonly kind: "syncSources"; readonly activeSourceIds: readonly string[] }
	| { readonly kind: "reload" }
	| { readonly kind: "invalidateCommands"; readonly provider: string | undefined };
export type ModelRegistryMirrorChange = ModelRegistryMirrorChangeInput & { readonly seq: number };
export interface ModelRegistryMirrorBatch {
	readonly seq: number;
	readonly changes: readonly ModelRegistryMirrorChange[];
}
interface RegisteredProvider {
	readonly config: ProviderConfigInput;
	readonly sourceId: string | undefined;
	readonly seq: number;
}

/** Manual model configuration, credential resolution, and live worker replicas. No network discovery. */
export class ModelRegistry {
	readonly #file: ConfigFile<ModelsConfig>;
	readonly #settings?: Settings;
	readonly #owner?: ModelRegistryOwner;
	readonly #inputs: ModelRegistryMirrorInputs;
	readonly #registered = new Map<string, RegisteredProvider>();
	readonly #listeners = new Set<(batch: ModelRegistryMirrorBatch) => void>();
	readonly #windowTiers = new WeakMap<Model, ContextWindowTiers>();
	readonly #refittedRows = new WeakMap<Model, Model>();
	#providers = new Map<string, ManualProviderConfig>();
	#models: Model[] = [];
	#error?: ConfigError;
	#mtime: number | null = null;
	#seq = 0;

	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		options?: { settings?: Settings; owner?: ModelRegistryOwner },
	) {
		this.#settings = options?.settings;
		this.#owner = options?.owner;
		this.#inputs = { modelsPath, settings: options?.settings };
		this.#file = ModelsConfigFile.relocate(modelsPath ?? path.join(getAgentDir(), "models.yml"));
		if (!this.#owner) this.authStorage.keys.setResolver(resolveConfigValue);
		this.#reload();
	}

	mirrorInputs(): ModelRegistryMirrorInputs {
		return this.#inputs;
	}
	subscribeMirror(listener: (batch: ModelRegistryMirrorBatch) => void): {
		snapshot: ModelRegistryMirrorBatch;
		unsubscribe: () => void;
	} {
		this.#listeners.add(listener);
		return {
			snapshot: {
				seq: this.#seq,
				changes: [...this.#registered]
					.map(([name, registration]): ModelRegistryMirrorChange => ({ kind: "register", name, ...registration }))
					.sort((a, b) => a.seq - b.seq),
			},
			unsubscribe: () => {
				this.#listeners.delete(listener);
			},
		};
	}

	applyMirrorBatch(batch: ModelRegistryMirrorBatch): void {
		if (!this.#owner) throw new Error("applyMirrorBatch requires an owner-backed registry.");
		for (const change of batch.changes) {
			if (change.seq <= this.#seq) continue;
			this.#applyChange(change);
			this.#seq = change.seq;
		}
		this.#seq = Math.max(this.#seq, batch.seq);
	}

	#applyChange(change: ModelRegistryMirrorChange): void {
		switch (change.kind) {
			case "register":
				this.#validateRegistration(change.name, change.config);
				this.#registered.set(change.name, { config: change.config, sourceId: change.sourceId, seq: change.seq });
				break;
			case "unregister":
				this.#registered.delete(change.name);
				break;
			case "clearSources":
				for (const [name, entry] of this.#registered)
					if (entry.sourceId && change.sourceIds.includes(entry.sourceId)) this.#registered.delete(name);
				break;
			case "syncSources":
				for (const [name, entry] of this.#registered)
					if (entry.sourceId && !change.activeSourceIds.includes(entry.sourceId)) this.#registered.delete(name);
				break;
			case "invalidateCommands":
				this.#invalidateCommands(change.provider);
				return;
			case "reload":
				break;
		}
		this.#reload();
	}

	#emit(change: ModelRegistryMirrorChangeInput): void {
		const numbered: ModelRegistryMirrorChange = { ...change, seq: ++this.#seq };
		this.#applyChange(numbered);
		for (const listener of this.#listeners) listener({ seq: this.#seq, changes: [numbered] });
	}

	#reload(): void {
		this.#file.invalidate();
		const loaded = this.#file.tryLoad();
		this.#mtime = this.#file.getMtimeMs();
		this.#error = loaded.status === "error" ? loaded.error : undefined;
		this.#providers = new Map(Object.entries(loaded.value?.providers ?? {}));
		for (const [name, registration] of this.#registered) {
			const config = registration.config;
			this.#providers.set(name, {
				baseUrl: config.baseUrl!,
				apiKey: config.apiKey,
				api: config.api,
				auth: config.auth,
				authHeader: config.authHeader,
				headers: config.headers,
				compat: config.compat,
				models: config.models ?? [],
			});
		}
		if (!this.#owner) {
			this.authStorage.keys.clearConfig();
			for (const [name, config] of this.#providers)
				if (config.apiKey) this.authStorage.keys.setConfig(name, config.apiKey);
		}
		this.#models = [...this.#providers].flatMap(([name, config]) => buildCustomModels(name, config));
		for (const model of this.#models) {
			if (
				model.contextWindow !== null &&
				model.maxContextWindow !== undefined &&
				model.maxContextWindow > model.contextWindow
			) {
				this.#windowTiers.set(model, { standard: model.contextWindow, extended: model.maxContextWindow });
			}
		}
	}

	async refresh(_strategy: ModelRefreshStrategy = "offline", options?: ModelRegistryRefreshOptions): Promise<void> {
		if (this.#owner) return this.#owner.refresh(_strategy, options);
		if (options?.refreshCommandCredentials) this.invalidateCommandConfigs();
		this.#emit({ kind: "reload" });
	}
	async refreshIfStale(): Promise<boolean> {
		if (this.#owner) return this.#owner.refreshIfStale();
		if (this.#file.getMtimeMs() === this.#mtime) return false;
		await this.refresh();
		return true;
	}
	getError(): ConfigError | undefined {
		return this.#error;
	}

	#isDisabled(provider: string): boolean {
		try {
			return cfgDisabledProviders.get(this.#settings ?? settings).includes(provider);
		} catch {
			return false;
		}
	}
	getAll(kind: ModelKind | "all" = "chat"): Model[] {
		return this.#models.filter(
			model => !this.#isDisabled(model.provider) && (kind === "all" || (model.kind ?? "chat") === kind),
		);
	}
	getAvailable(kind: ModelKind | "all" = "chat"): Model[] {
		return this.getAll(kind).filter(model => this.hasConfiguredAuth(model));
	}
	getAvailableForProviders(providers: ReadonlySet<string>, kind: ModelKind | "all" = "chat"): Model[] {
		return this.getAvailable(kind).filter(model => providers.has(model.provider));
	}
	find(provider: string, modelId: string): Model | undefined {
		return this.getAll().find(model => model.provider === provider && model.id === modelId);
	}
	getProviderModels(provider: string): Model[] {
		return this.getAll("all").filter(model => model.provider === provider);
	}
	hasProvider(provider: string): boolean {
		return this.#providers.has(provider) && !this.#isDisabled(provider);
	}
	getProviderBaseUrl(provider: string): string | undefined {
		return this.#providers.get(provider)?.baseUrl;
	}
	hasConfiguredAuth(model: Pick<Model, "provider">): boolean {
		if (this.#isDisabled(model.provider)) return false;
		return (
			this.#providers.get(model.provider)?.auth === "none" ||
			this.authStorage.keys.source(model.provider) !== undefined
		);
	}
	hasConcreteAuth(provider: string): boolean {
		return this.hasConfiguredAuth({ provider });
	}
	hasCommandBackedApiKey(provider: string): boolean {
		return isCommandConfigValue(this.#providers.get(provider)?.apiKey);
	}

	async getProviderHeaders(provider: string): Promise<Record<string, string> | undefined> {
		return createConfigHeaderResolver([this.#providers.get(provider)?.headers])?.();
	}
	async resolveModelHeaders(model: Model, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
		return model.resolveHeaders ? model.resolveHeaders(signal) : model.headers ? { ...model.headers } : undefined;
	}
	async getApiKey(
		model: Pick<Model, "provider" | "id" | "baseUrl">,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined> {
		return this.getApiKeyForProvider(model.provider, sessionId, {
			modelId: model.id,
			baseUrl: model.baseUrl,
			signal: options?.signal,
		});
	}
	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<string | undefined> {
		return (await this.getApiKeyWithCredentialForProvider(provider, sessionId, options))?.apiKey;
	}
	async getApiKeyWithCredentialForProvider(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined> {
		if (this.#isDisabled(provider)) return undefined;
		if (this.#providers.get(provider)?.auth === "none") return { apiKey: kNoAuth };
		return this.authStorage.keys.getWithCredential(provider, sessionId, options);
	}
	async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
		const apiKey = await this.getApiKey(model);
		if (apiKey === undefined) return { ok: false, error: `No API key configured for "${model.provider}".` };
		return { ok: true, apiKey, headers: await this.resolveModelHeaders(model) };
	}
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	resolver(target: string | ApiKeyResolverModel, optionsOrSessionId?: ApiKeyResolverOptions | string): ApiKeyResolver {
		const options = typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : optionsOrSessionId;
		return typeof target === "string"
			? createApiKeyResolver(this, target, options)
			: createApiKeyResolver(this, target.provider, { ...options, baseUrl: target.baseUrl, modelId: target.id });
	}

	#invalidateCommands(provider?: string): void {
		if (provider === undefined) invalidateAllCommandConfigs();
		else {
			const config = this.#providers.get(provider);
			invalidateCommandConfig(config?.apiKey);
			for (const value of Object.values(config?.headers ?? {})) invalidateCommandConfig(value);
			for (const model of config?.models ?? [])
				for (const value of Object.values(model.headers ?? {})) invalidateCommandConfig(value);
		}
	}
	invalidateCommandConfigs(provider?: string): void {
		if (this.#owner) return this.#owner.invalidateCommandConfigs(provider);
		this.#emit({ kind: "invalidateCommands", provider });
	}

	#validateRegistration(name: string, config: ProviderConfigInput): void {
		for (const retired of [
			"streamSimple",
			"oauth",
			"usage",
			"fetchDynamicModels",
			"discovery",
			"transport",
			"remoteCompaction",
		]) {
			if (Object.hasOwn(config, retired))
				throw new Error(`Provider ${name}: "${retired}" is not supported. Configure a Chat Completions endpoint.`);
		}
		validateProviderConfiguration(name, { ...config, models: config.models ?? [] }, "runtime-register");
	}
	registerProvider(name: string, config: ProviderConfigInput, sourceId?: string): void {
		this.#validateRegistration(name, config);
		if (this.#owner) throw new Error("Manual provider registrations must be made on the owner registry.");
		this.#emit({ kind: "register", name, config, sourceId });
	}
	unregisterProvider(name: string): void {
		if (this.#owner) throw new Error("Provider removal must be made on the owner registry.");
		this.#emit({ kind: "unregister", name });
	}
	clearSourceRegistrations(sourceIds: string | Iterable<string>): void {
		if (this.#owner) throw new Error("Provider sources must be changed on the owner registry.");
		this.#emit({ kind: "clearSources", sourceIds: typeof sourceIds === "string" ? [sourceIds] : [...sourceIds] });
	}
	syncExtensionSources(activeSourceIds: string[]): void {
		if (this.#owner) throw new Error("Provider sources must be changed on the owner registry.");
		this.#emit({ kind: "syncSources", activeSourceIds });
	}
	contextWindowTiers(model: { provider: string; id: string }): ContextWindowTiers | undefined {
		const configured = this.find(model.provider, model.id);
		return configured ? this.#windowTiers.get(configured) : undefined;
	}
	fitContextWindow(model: Model, scope: Settings): Model {
		const tiers =
			this.#windowTiers.get(model) ??
			(model.contextWindow !== null &&
			model.maxContextWindow !== undefined &&
			model.maxContextWindow > model.contextWindow
				? { standard: model.contextWindow, extended: model.maxContextWindow }
				: undefined);
		if (!tiers) return model;
		const points = cfgCompactionModelThresholdsEnabled.get(scope)
			? cfgCompactionModelThresholds.get(scope)
			: undefined;
		const threshold = matchModelCompactionThreshold(points, model)?.threshold;
		const thresholdNeedsExtended =
			threshold &&
			threshold.thresholdTokens > 0 &&
			(threshold.fixed ? threshold.thresholdTokens >= tiers.standard : threshold.thresholdTokens > tiers.standard);
		const contextWindow = cfgExtendedContext.get(scope) || thresholdNeedsExtended ? tiers.extended : tiers.standard;
		if (model.contextWindow === contextWindow) return model;
		const cached = this.#refittedRows.get(model);
		if (cached?.contextWindow === contextWindow) return cached;
		const result = buildModel({ ...model, contextWindow });
		this.#windowTiers.set(result, tiers);
		this.#refittedRows.set(model, result);
		return result;
	}
}
