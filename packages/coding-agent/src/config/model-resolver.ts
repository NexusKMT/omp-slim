/** Model selection over explicitly configured Chat Completions endpoints. */
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	MAX_THINKING_SUFFIX_OPTIONS,
	parseModelString,
	splitThinkingSuffix,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "./model-registry";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
	type ModelRoleLookup,
} from "./model-roles";
import { cfgDisabledProviders, cfgEnabledModels, cfgModelProviderOrder } from "./model-settings";
import type { Settings } from "./settings";

export interface ScopedModel {
	model: Model;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}
export interface ModelMatchPreferences {
	usageOrder?: string[];
	providerOrder?: readonly string[];
	deprioritizeProviders?: string[];
	isKnownProvider?: (provider: string) => boolean;
}
export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable">;
export interface ParsedModelResult {
	model: Model | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}
export interface ResolvedModelRoleValue extends ParsedModelResult {
	matchedPatternIndex?: number;
}

export function formatModelString(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}
/** Historical API spelling; endpoint routing is now the configured model itself. */
export const formatModelStringWithRouting = formatModelString;

export function getModelMatchPreferences(settings?: Settings): ModelMatchPreferences {
	return settings
		? { usageOrder: settings.getStorage()?.getModelUsageOrder(), providerOrder: cfgModelProviderOrder.get(settings) }
		: {};
}

/** Configuration order is the only default; no vendor has an implicit preference. */
export function pickDefaultAvailableModel(
	models: Model[],
	hasConcreteCredential?: (provider: string) => boolean,
): Model | undefined {
	return hasConcreteCredential ? models.find(model => hasConcreteCredential(model.provider)) : models[0];
}

function ranked(models: readonly Model[], preferences?: ModelMatchPreferences): Model[] {
	const rank = (values: readonly string[] | undefined, value: string) => {
		const index = values?.indexOf(value) ?? -1;
		return index < 0 ? Infinity : index;
	};
	return [...models].sort((a, b) => {
		const used =
			rank(preferences?.usageOrder, formatModelString(a)) - rank(preferences?.usageOrder, formatModelString(b));
		if (!Number.isNaN(used) && used !== 0) return used;
		const provider = rank(preferences?.providerOrder, a.provider) - rank(preferences?.providerOrder, b.provider);
		if (!Number.isNaN(provider) && provider !== 0) return provider;
		return (
			Number(preferences?.deprioritizeProviders?.includes(a.provider)) -
			Number(preferences?.deprioritizeProviders?.includes(b.provider))
		);
	});
}

function literalMatch(value: string, models: readonly Model[], preferences?: ModelMatchPreferences): Model | undefined {
	return (
		models.find(model => formatModelString(model) === value) ??
		ranked(
			models.filter(model => model.id === value),
			preferences,
		)[0]
	);
}

function matchName(
	value: string,
	models: readonly Model[],
	preferences?: ModelMatchPreferences,
	exactOnly = false,
): Model | undefined {
	const exact = literalMatch(value, models, preferences);
	if (exact || exactOnly || value.startsWith("@") || value.startsWith("pi/") || value.includes("@")) return exact;
	const slash = value.indexOf("/");
	const provider = slash < 0 ? undefined : value.slice(0, slash);
	if (provider && (models.some(model => model.provider === provider) || preferences?.isKnownProvider?.(provider)))
		return undefined;
	const needle = value.toLowerCase();
	return ranked(
		models.filter(model => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)),
		preferences,
	)[0];
}

export function parseModelPattern(
	pattern: string,
	available: Model[],
	preferences?: ModelMatchPreferences,
	options?: { allowInvalidThinkingSelectorFallback?: boolean; exactOnly?: boolean },
): ParsedModelResult {
	const selector = pattern.trim();
	const literal = literalMatch(selector, available, preferences);
	if (literal) return { model: literal, warning: undefined, explicitThinkingLevel: false };
	const suffix = splitThinkingSuffix(selector, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (suffix.level !== undefined) {
		const model = matchName(suffix.base, available, preferences, options?.exactOnly);
		return { model, thinkingLevel: suffix.level, warning: undefined, explicitThinkingLevel: true };
	}
	const model = matchName(selector, available, preferences, options?.exactOnly);
	if (model) return { model, warning: undefined, explicitThinkingLevel: false };
	return {
		model: undefined,
		warning: selector.includes("@")
			? "Upstream routing selectors are not supported; configure the endpoint baseUrl and model id directly."
			: undefined,
		explicitThinkingLevel: false,
	};
}

export function resolveProviderModelReference(
	provider: string,
	id: string,
	available: readonly Model[],
): Model | undefined {
	return available.find(model => model.provider === provider && model.id === id);
}

export function providerModelHint(selector: string, available: readonly Model[]): string {
	const matches = available.filter(model => model.id === selector).map(formatModelString);
	return matches.length
		? `Use a configured selector: ${matches.join(", ")}.`
		: "Configure the endpoint baseUrl, apiKey and model id in models.yml.";
}
const DEFAULT_MODEL_ROLE = "default";
const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, LEGACY_MODEL_ROLE_ALIAS_PREFIX];

/**
 * Minimum colon index for splitting a `:<level>` suffix off a role alias, or
 * `undefined` when `value` is not role-alias shaped. Doubles as the slice
 * offset of the role name for prefixed aliases (`@role`, `pi/role`); the bare
 * `*` default alias returns 0 because its colon sits immediately after the
 * one-character token (`*:xhigh`).
 */
function modelRoleAliasPrefixLength(value: string): number | undefined {
	if (value === DEFAULT_MODEL_ROLE_ALIAS || value.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) return 0;
	return MODEL_ROLE_ALIAS_PREFIXES.find(prefix => value.startsWith(prefix))?.length;
}

function getModelRoleAlias(value: string, _settings?: ModelRoleLookup): string | undefined {
	const normalized = value.trim();
	const prefixLength = modelRoleAliasPrefixLength(normalized);
	if (prefixLength === undefined) return undefined;
	const candidate = normalized === DEFAULT_MODEL_ROLE_ALIAS ? DEFAULT_MODEL_ROLE : normalized.slice(prefixLength);
	return candidate === DEFAULT_MODEL_ROLE ? DEFAULT_MODEL_ROLE : undefined;
}

/** Normalize comma-separated or array model selectors into an ordered pattern list. */
export function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

/**
 * Extract the first explicit model-role alias from a raw model selection.
 *
 * Only the legacy default aliases are accepted. Retired role names never
 * select a different model.
 */
export function resolveExplicitModelRole(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string | undefined {
	for (const pattern of normalizeModelPatternList(value)) {
		const prefixLength = modelRoleAliasPrefixLength(pattern);
		if (prefixLength === undefined) continue;
		const { base } = splitThinkingSuffix(pattern, prefixLength, MAX_THINKING_SUFFIX_OPTIONS);
		const role = getModelRoleAlias(base, settings);
		if (role) return role;
	}
	return undefined;
}

function resolveConfiguredRolePattern(
	value: string,
	settings?: ModelRoleLookup,
	visited = new Set<string>(),
): string[] | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;
	const { base, level } = splitThinkingSuffix(
		normalized,
		modelRoleAliasPrefixLength(normalized) ?? -1,
		MAX_THINKING_SUFFIX_OPTIONS,
	);
	const role = getModelRoleAlias(base);
	if (!role) {
		// @role and pi/role are retired selectors, not fuzzy model names. Refusing
		// them prevents an old role from accidentally selecting a different model.
		if (modelRoleAliasPrefixLength(normalized) !== undefined) return [];
		return [normalized];
	}
	if (visited.has(role)) return [];
	visited.add(role);
	const configured = settings?.getModelRole("default");
	if (!configured) return [];
	const patterns = normalizeModelPatternList(configured).flatMap(
		pattern => resolveConfiguredRolePattern(pattern, settings, visited) ?? [],
	);
	return level ? patterns.map(pattern => `${pattern}:${level}`) : patterns;
}

/**
 * Expand the legacy default alias to the primary model string.
 */
export function expandRoleAlias(value: string, settings?: ModelRoleLookup): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE) {
		return settings?.getModelRole("default") ?? value;
	}

	const resolved = resolveConfiguredRolePattern(value, settings)?.[0];
	return resolved ?? value;
}

export function resolveConfiguredModelPatterns(
	value: string | string[] | undefined,
	settings?: ModelRoleLookup,
): string[] {
	const patterns = normalizeModelPatternList(value);
	return patterns.flatMap(pattern => {
		const resolved = resolveConfiguredRolePattern(pattern, settings);
		return resolved ?? [];
	});
}
export interface AgentAdvisorResolutionOptions {
	/** `task.agentAdvisor` settings value for this agent: `"on"` or `"off"`; legacy model strings only enable it. */
	settingsOverride?: string;
	/** Agent definition `advisor` frontmatter: `true` enables it; legacy model strings only enable it. */
	agentAdvisor?: boolean | string;
}

/** Enablement only: advisors inherit their owning session's model. */
export interface AgentAdvisorSelection {
	enabled: true;
}

export function resolveAgentAdvisorSelection(
	options: AgentAdvisorResolutionOptions,
): AgentAdvisorSelection | undefined {
	const configured = options.settingsOverride?.trim().toLowerCase();
	if (configured === "off" || configured === "false") return undefined;
	if (configured) return { enabled: true };
	const advisor = options.agentAdvisor;
	if (advisor === true || (typeof advisor === "string" && advisor.trim())) return { enabled: true };
	return undefined;
}

interface ExplicitThinkingSelectorOptions {
	/** Exact ID lookup; an undefined provider checks unqualified IDs across the caller's model set. */
	isLiteralModelId?: (provider: string | undefined, id: string) => boolean;
}

function isLiteralModelSelector(value: string, options?: ExplicitThinkingSelectorOptions): boolean {
	const parsed = parseModelString(value);
	if (parsed) return options?.isLiteralModelId?.(parsed.provider, parsed.id) === true;
	return options?.isLiteralModelId?.(undefined, value) === true;
}

export function extractExplicitThinkingSelector(
	value: string | undefined,
	settings?: Settings,
	options?: ExplicitThinkingSelectorOptions,
): ConfiguredThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		if (isLiteralModelSelector(current, options)) return undefined;
		const rolePrefixLength = modelRoleAliasPrefixLength(current) ?? 0;
		const strictSelector = splitThinkingSuffix(current, rolePrefixLength).level;
		if (strictSelector) {
			return strictSelector;
		}
		const maxSelector = splitThinkingSuffix(current, rolePrefixLength, MAX_THINKING_SUFFIX_OPTIONS).level;
		if (
			maxSelector &&
			(modelRoleAliasPrefixLength(current) !== undefined || !isLiteralModelSelector(current, options))
		) {
			return maxSelector;
		}
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === DEFAULT_MODEL_ROLE) return undefined;
		current = expanded;
	}

	return undefined;
}

export function resolveModelRoleValue(
	value: string | undefined,
	available: Model[],
	options?: { settings?: Settings; roleLookup?: ModelRoleLookup; matchPreferences?: ModelMatchPreferences },
): ResolvedModelRoleValue {
	const patterns = resolveConfiguredModelPatterns(value, options?.roleLookup ?? options?.settings);
	let warning: string | undefined;
	for (const [matchedPatternIndex, pattern] of patterns.entries()) {
		const result = parseModelPattern(
			pattern,
			available,
			options?.matchPreferences ?? getModelMatchPreferences(options?.settings),
		);
		if (result.model) return { ...result, matchedPatternIndex };
		warning ??= result.warning;
	}
	return { model: undefined, warning, explicitThinkingLevel: false };
}

export function resolveModelFromString(
	value: string,
	available: Model[],
	preferences?: ModelMatchPreferences,
): Model | undefined {
	return parseModelPattern(value, available, preferences).model;
}

export function resolveModelOverride(
	patterns: string[],
	registry: ModelLookupRegistry,
	settings?: Settings,
	options?: { exactOnly?: boolean },
): ParsedModelResult {
	const available = registry.getAvailable();
	for (const pattern of options?.exactOnly ? patterns : resolveConfiguredModelPatterns(patterns, settings)) {
		const result = parseModelPattern(pattern, available, getModelMatchPreferences(settings), options);
		if (result.model) return result;
	}
	return { model: undefined, warning: undefined, explicitThinkingLevel: false };
}

export function resolvePrimaryModelSelection(
	settings: Settings,
	available: Model[],
	currentModel?: Model,
): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	if (currentModel) return { model: currentModel };
	const resolved = resolveModelRoleValue(settings.getModel(), available, { settings });
	return resolved.model ? { model: resolved.model, thinkingLevel: resolved.thinkingLevel } : undefined;
}

export function disabledProviderIds(settings?: Settings): ReadonlySet<string> {
	return new Set(settings ? cfgDisabledProviders.get(settings) : []);
}

export function resolveSessionModelSelector(
	registry: ModelRegistry,
	selector: string,
): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const result = parseModelPattern(selector, registry.getAll(), undefined, { exactOnly: true });
	return result.model && registry.hasConfiguredAuth(result.model)
		? { model: result.model, thinkingLevel: result.thinkingLevel }
		: undefined;
}

function resolveScope(
	patterns: readonly string[],
	available: Model[],
	preferences?: ModelMatchPreferences,
	settings?: Settings,
): ScopedModel[] {
	const scoped: ScopedModel[] = [];
	const seen = new Set<Model>();
	for (const raw of patterns) {
		const isDefaultAlias = raw === "*" || raw.startsWith("*:");
		const expanded =
			isDefaultAlias || raw.startsWith("@") || raw.startsWith("pi/")
				? resolveConfiguredModelPatterns(raw, settings)
				: [raw];
		for (const pattern of expanded) {
			const suffix = literalMatch(pattern, available)
				? { base: pattern, level: undefined }
				: splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
			const glob = /[*?\[]/.test(suffix.base) ? new Bun.Glob(suffix.base) : undefined;
			const matches = glob
				? available.filter(model => glob.match(formatModelString(model)) || glob.match(model.id))
				: [parseModelPattern(pattern, available, preferences).model].filter(
						(model): model is Model => model !== undefined,
					);
			for (const model of matches) {
				if (seen.has(model)) continue;
				seen.add(model);
				const thinkingLevel = concreteThinkingLevel(suffix.level);
				scoped.push({ model, thinkingLevel, explicitThinkingLevel: suffix.level !== undefined });
			}
		}
	}
	return scoped;
}
export async function resolveModelScope(
	patterns: string[],
	registry: ModelLookupRegistry,
	preferences?: ModelMatchPreferences,
	settings?: Settings,
): Promise<ScopedModel[]> {
	return resolveScope(patterns, registry.getAvailable(), preferences, settings);
}
export async function resolveAllowedModels(
	registry: ModelLookupRegistry,
	settings: Settings | undefined,
	preferences?: ModelMatchPreferences,
): Promise<Model[]> {
	const available = registry.getAvailable();
	const patterns = settings ? cfgEnabledModels.get(settings) : [];
	return patterns.length
		? resolveScope(patterns, available, preferences, settings).map(entry => entry.model)
		: available;
}
export function filterAvailableModelsByEnabledPatterns(
	available: Model[],
	patterns: readonly string[],
	settings?: Settings,
): Model[] {
	return patterns.length
		? resolveScope(patterns, available, getModelMatchPreferences(settings), settings).map(entry => entry.model)
		: available;
}

export interface ResolveCliModelResult {
	model: Model | undefined;
	configuredPatterns?: string[];
	configuredRole?: string;
	configuredPatternIndex?: number;
	selector?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
	disabledProvider?: string;
}
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: Pick<ModelRegistry, "getAll" | "getAvailable"> & Partial<Pick<ModelRegistry, "hasProvider">>;
	availableModels?: Model[];
	settings?: Settings;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliModel, cliProvider, modelRegistry, settings } = options;
	if (!cliModel) return { model: undefined, warning: undefined, error: undefined };
	const selector = cliProvider ? `${cliProvider}/${cliModel}` : cliModel;
	const disabled = disabledProviderIds(settings);
	const provider = cliProvider ?? selector.slice(0, selector.indexOf("/"));
	if (provider && disabled.has(provider))
		return {
			model: undefined,
			selector,
			warning: undefined,
			error: `Provider "${provider}" is disabled.`,
			disabledProvider: provider,
		};
	const available = (options.availableModels ?? modelRegistry.getAvailable()).filter(
		model => !disabled.has(model.provider),
	);
	const all = modelRegistry.getAll().filter(model => !disabled.has(model.provider));
	const lookup = {
		...getModelMatchPreferences(settings),
		...options.preferences,
		isKnownProvider: (id: string) => modelRegistry.hasProvider?.(id) ?? all.some(model => model.provider === id),
	};
	const patterns = resolveConfiguredModelPatterns(selector, settings);
	for (const [configuredPatternIndex, pattern] of patterns.entries()) {
		const literal = literalMatch(pattern, all, lookup);
		const result = literal
			? { model: literal, warning: undefined, explicitThinkingLevel: false }
			: parseModelPattern(pattern, available, lookup);
		const resolved = result.model ? result : parseModelPattern(pattern, all, lookup);
		if (resolved.model)
			return {
				model: resolved.model,
				selector,
				thinkingLevel: resolved.thinkingLevel,
				configuredPatterns: patterns,
				configuredPatternIndex,
				configuredRole: resolveExplicitModelRole(selector, settings),
				warning: resolved.warning,
				error: undefined,
			};
	}
	return {
		model: undefined,
		selector,
		warning: undefined,
		error: `Model "${selector}" is not configured. ${providerModelHint(cliModel, all)}`,
	};
}
