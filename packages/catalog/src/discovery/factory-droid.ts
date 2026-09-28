import { isRecord } from "@oh-my-pi/pi-utils";
import { resolveModelPolicy } from "../compat/resolve";
import type { RequestPolicy } from "../compat/types";
import { type Effort, THINKING_EFFORTS } from "../effort";
import { getBundledModel } from "../models";
import type { FetchImpl, ModelSpec, ThinkingConfig, ThinkingControlMode } from "../types";
import {
	type AccountScope,
	factoryDroidApiBaseUrl,
	factoryDroidClientHeaders,
	factoryDroidWireBaseUrl,
	resolveFactoryDroidInferenceRegion,
} from "../wire/factory-droid";
import {
	FACTORY_DROID_MODELS,
	type FactoryDroidModelInput,
	factoryDroidRegionalLimits,
	resolveFactoryDroidRotation,
} from "./factory-droid-models";

/**
 * Factory Droid (Droid Core + Standard Credits subscription) — direct HTTP
 * integration.
 *
 * The model registry is bundled statically (see `./factory-droid-models.ts`):
 * Factory has no model-listing endpoint, so first-party clients ship that
 * table and narrow it live with Statsig feature flags and the org model
 * policy. This module holds the discovery logic: policy parsing, availability
 * filtering, routing, and building model specs from the registry.
 */

/** User-facing effort rungs, derived from the shared thinking ladder. */
const SUPPORTED_EFFORTS = new Set<string>(THINKING_EFFORTS);

/** Org policy subset from `/api/organization/managed-settings` that gates models. */
interface FactoryModelPolicy {
	allowAllFactoryModels?: boolean;
	allowedModelIds?: string[];
	blockedModelIds?: string[];
	/** Models requiring explicit consent are denied when listed here. */
	requireExplicitOptInModelIds?: string[];
	/**
	 * Org switch for the paid fast tiers. Absent means allow: the CLI's
	 * default policy kind is allow-all, and self-hosted/legacy servers omit
	 * the field entirely, so only an explicit `false` withdraws them.
	 */
	isFastModelsAllowed?: boolean;
}

function canonicalPolicyId(id: string): string {
	return FACTORY_DROID_MODELS.find(model => model.id === id || model.policyAliases?.includes(id))?.id ?? id;
}

function readModelPolicy(body: unknown): FactoryModelPolicy | null {
	if (!isRecord(body) || !isRecord(body.settings)) return null;
	const policy = body.settings.modelPolicy;
	if (!isRecord(policy)) return null;
	const ids = (key: "allowedModelIds" | "blockedModelIds" | "requireExplicitOptInModelIds"): string[] | undefined => {
		const value = policy[key];
		return Array.isArray(value)
			? [...new Set(value.filter((v): v is string => typeof v === "string").map(canonicalPolicyId))]
			: undefined;
	};
	return {
		allowAllFactoryModels:
			typeof policy.allowAllFactoryModels === "boolean" ? policy.allowAllFactoryModels : undefined,
		allowedModelIds: ids("allowedModelIds"),
		blockedModelIds: ids("blockedModelIds"),
		requireExplicitOptInModelIds: ids("requireExplicitOptInModelIds"),
		isFastModelsAllowed: typeof policy.isFastModelsAllowed === "boolean" ? policy.isFastModelsAllowed : undefined,
	};
}

/**
 * Live `provider_routing` dynamic config from the flags payload: per-model
 * upstream rotations that override the registry's static order.
 */
interface FactoryProviderRouting {
	models?: Record<string, readonly string[]>;
	defaults?: Record<string, readonly string[]>;
	blockedProviders?: Record<string, readonly string[]>;
}

/** Reads `configs.provider_routing` from the feature-flags payload. */
function readProviderRouting(body: Record<string, unknown>): FactoryProviderRouting | null {
	if (!isRecord(body.configs) || !isRecord(body.configs.provider_routing)) return null;
	const routing = body.configs.provider_routing;
	const parse = (value: unknown): Record<string, readonly string[]> => {
		if (!isRecord(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string[]] =>
					Array.isArray(entry[1]) && entry[1].every(provider => typeof provider === "string"),
			),
		);
	};
	return {
		models: parse(routing.models),
		defaults: parse(routing.defaults),
		blockedProviders: parse(routing.blockedProviders),
	};
}

/** Mirrors the client-side model gating: feature flags first, then org model policy. */
function isModelAvailable(
	model: FactoryDroidModelInput,
	flags: Record<string, boolean>,
	policy: FactoryModelPolicy | null,
	region: string | undefined,
): boolean {
	if (resolveFactoryDroidRotation(model, region).length === 0) return false;
	if (model.featureFlag !== undefined && flags[model.featureFlag] !== true) return false;
	if (model.deprecationFlag !== undefined && flags[model.deprecationFlag] === true) return false;
	// Fast tiers are withdrawn as a class, not by id: `baseVariant` is what
	// marks an entry as one, and only an explicit `false` hides it.
	if (model.baseVariant !== undefined && policy?.isFastModelsAllowed === false) return false;
	if (policy?.requireExplicitOptInModelIds?.includes(model.id) || (!policy && model.requiresExplicitOptIn))
		return false;
	const allowlist = policy?.allowAllFactoryModels === false || Boolean(policy?.allowedModelIds?.length);
	if (policy?.blockedModelIds?.includes(model.id)) return false;
	if (allowlist && !policy?.allowedModelIds?.includes(model.id)) return false;
	return true;
}

export interface FactoryDroidModelDiscoveryOptions extends AccountScope {
	/** OMP-stored WorkOS access token (from `/login factory-droid`), when present. */
	apiKey?: string;
	fetch?: FetchImpl;
}

/**
 * Offline seed: the registry narrowed by the same availability rule live
 * discovery applies, with no flags or org policy known yet. Feature-gated and
 * explicit-opt-in models stay hidden until an online refresh proves access.
 */
export function factoryDroidSeedModels(scope: AccountScope): ModelSpec<"factory-droid-agent">[] {
	const inferenceRegion = resolveFactoryDroidInferenceRegion(scope);
	return FACTORY_DROID_MODELS.filter(model => isModelAvailable(model, {}, null, inferenceRegion)).map(model =>
		buildFactoryDroidModel(model, {
			region: scope.region,
			inferenceRegion,
			orgId: scope.orgId,
			apiProviders: resolveFactoryDroidRotation(model, inferenceRegion),
		}),
	);
}

/**
 * Availability filter, not a catalog: Factory has no model-listing endpoint,
 * so the bundled registry is narrowed live with `GET /api/feature-flags`
 * (Statsig gates) and the org model policy in
 * `GET /api/organization/managed-settings`. Returns null when no credential
 * resolves or the flags fetch fails — callers keep an offline snapshot, not
 * evidence of current entitlement. Missing policy denies explicit-opt-in models.
 */
export async function fetchFactoryDroidModels(
	options: FactoryDroidModelDiscoveryOptions = {},
): Promise<ModelSpec<"factory-droid-agent">[] | null> {
	const token = options.apiKey?.trim();
	if (!token) return null;
	const fetchImpl = options.fetch ?? fetch;
	const headers = { Authorization: `Bearer ${token}`, ...factoryDroidClientHeaders(options.orgId) };
	const apiBaseUrl = factoryDroidApiBaseUrl(options.region);
	let flags: Record<string, boolean>;
	let policy: FactoryModelPolicy | null = null;
	let routing: FactoryProviderRouting | null = null;
	const servingRegion = resolveFactoryDroidInferenceRegion(options);
	try {
		const [flagsResponse, settingsResponse] = await Promise.all([
			fetchImpl(`${apiBaseUrl}/api/feature-flags`, { headers }),
			fetchImpl(`${apiBaseUrl}/api/organization/managed-settings`, { headers }).catch(() => null),
		]);
		if (!flagsResponse.ok) return null;
		const body: unknown = await flagsResponse.json();
		if (body == null || typeof body !== "object" || !("flags" in body)) return null;
		const raw = body.flags;
		if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
		flags = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value === true]));
		if (settingsResponse?.ok) {
			policy = readModelPolicy(await settingsResponse.json());
		}
		routing = readProviderRouting(body as Record<string, unknown>);
	} catch {
		return null;
	}
	return FACTORY_DROID_MODELS.flatMap(model => {
		if (!isModelAvailable(model, flags, policy, servingRegion)) return [];
		const routed = routing?.models?.[model.id] ?? routing?.defaults?.[model.routingFamily];
		const rotation = resolveRotation(model, routed, servingRegion, routing?.blockedProviders?.[model.id]);
		if (rotation.length === 0) return [];
		const spec = buildFactoryDroidModel(model, {
			region: options.region,
			inferenceRegion: servingRegion,
			orgId: options.orgId,
			apiProviders: rotation,
		});
		// Native reports configured ordering only when live routing chose the rotation.
		if (routed !== undefined) spec.factoryDroidRoutingSource = "configured_order";
		return [spec];
	});
}

/**
 * Intersect live rotations with registry eligibility and explicit blocks.
 * An explicitly configured empty/disallowed rotation never widens to defaults.
 */
function resolveRotation(
	input: FactoryDroidModelInput,
	routed: readonly string[] | undefined,
	region: string | undefined,
	blocked: readonly string[] = [],
): readonly string[] {
	const eligible = resolveFactoryDroidRotation(input, region).filter(provider => !blocked.includes(provider));
	return routed === undefined
		? eligible
		: routed.filter(provider => eligible.some(candidate => candidate === provider));
}

/** Account scope plus the upstream rotation resolved for that account. */
export interface FactoryDroidModelBuildOptions extends AccountScope {
	apiProviders?: readonly string[];
}

export function buildFactoryDroidModel(
	input: FactoryDroidModelInput,
	options: FactoryDroidModelBuildOptions = {},
): ModelSpec<"factory-droid-agent"> {
	// Runtime-unsafe lookup by design: a models.json regen can drop a referenced
	// id, and a missing reference must degrade to zero cost, not break discovery.
	const reference = input.priceRef ? getBundledModel(input.priceRef.provider, input.priceRef.modelId) : undefined;
	const model: ModelSpec<"factory-droid-agent"> = {
		id: input.id,
		name: input.name,
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl: factoryDroidWireBaseUrl(input.wire, options.region),
		reasoning: true,
		input: input.noImageSupport ? ["text"] : ["text", "image"],
		cost: reference?.cost ? { ...reference.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...factoryDroidRegionalLimits(input, resolveFactoryDroidInferenceRegion(options)),
		...(options.orgId ? { factoryDroidOrgId: options.orgId } : {}),
		...(input.credits ? { factoryDroidCredits: input.credits.input } : {}),
		...(options.apiProviders?.length ? { factoryDroidApiProviders: [...options.apiProviders] } : {}),
	};
	model.thinking = buildFactoryDroidThinking(input, resolveModelPolicy(model).request.anthropicThinking);
	model.reasoning = model.thinking !== undefined;
	return model;
}

/**
 * The thinking control mode rides the wire family, not the model: Anthropic
 * variants use per-model adaptive vs budget thinking, Gemini uses
 * thinkingLevel, and the completions/responses families take the generic
 * effort field.
 */
function buildFactoryDroidThinking(
	input: FactoryDroidModelInput,
	thinkingStyle: RequestPolicy["anthropicThinking"],
): ThinkingConfig | undefined {
	const available = input.supportedReasoningEfforts ?? [];
	const efforts = available.filter((effort): effort is Effort => SUPPORTED_EFFORTS.has(effort));
	if (efforts.length === 0) return undefined;
	const supportsOff = available.includes("off") || available.includes("none");
	const mode: ThinkingControlMode =
		input.wire === "google-generate"
			? "google-level"
			: input.wire === "anthropic-messages"
				? thinkingStyle === "budget-interleaved"
					? "budget"
					: thinkingStyle === "budget-effort"
						? "anthropic-budget-effort"
						: "anthropic-adaptive"
				: "effort";
	return {
		mode,
		efforts,
		// Only summarized adaptive thinking carries `display` natively; every other
		// Messages style must not send it.
		...(input.wire === "anthropic-messages" ? { supportsDisplay: thinkingStyle === "adaptive-summarized" } : {}),
		requiresEffort: !supportsOff,
		...(input.defaultReasoningEffort && SUPPORTED_EFFORTS.has(input.defaultReasoningEffort)
			? { defaultLevel: input.defaultReasoningEffort as Effort }
			: undefined),
	};
}
