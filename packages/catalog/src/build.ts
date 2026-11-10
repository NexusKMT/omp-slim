import { THINKING_EFFORTS } from "./effort";
import type { Api, Model, ModelSpec } from "./types";

/** Validate the supported wire protocol without translating historical protocol names. */
export function requireChatCompletionsApi(api: string | undefined): "openai-completions" {
	if (api !== undefined && api !== "openai-completions") {
		throw new Error(`Unsupported model API "${api}". OMP Slim supports only "openai-completions".`);
	}
	return "openai-completions";
}

function positiveLimit(value: number | null | undefined, fallback: number, name: string): number | null {
	if (value === null) return null;
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number or null.`);
	return value;
}

/** Materialize manually configured metadata. Names never infer capabilities or transport. */
export function buildModel<TApi extends Api = "openai-completions">(spec: ModelSpec<TApi>): Model<TApi> {
	const api = requireChatCompletionsApi(spec.api);
	if (!spec.id.trim()) throw new Error("A model id is required.");
	if (!spec.provider.trim()) throw new Error("A provider name is required.");
	let endpoint: URL;
	try {
		endpoint = new URL(spec.baseUrl);
	} catch {
		throw new Error("Model baseUrl must be an absolute HTTP(S) URL.");
	}
	if (!["http:", "https:"].includes(endpoint.protocol)) {
		throw new Error("Model baseUrl must be an absolute HTTP(S) URL.");
	}
	if (spec.kind !== undefined && spec.kind !== "chat") throw new Error(`Unsupported model kind "${spec.kind}".`);
	if (spec.thinking) {
		if (spec.thinking.mode !== "effort") throw new Error('Thinking mode must be "effort".');
		if (
			spec.thinking.efforts.length === 0 ||
			spec.thinking.efforts.some(effort => !THINKING_EFFORTS.includes(effort))
		) {
			throw new Error("Thinking efforts must contain supported effort levels.");
		}
		if (spec.thinking.defaultLevel && !spec.thinking.efforts.includes(spec.thinking.defaultLevel)) {
			throw new Error("The default thinking effort must be included in thinking.efforts.");
		}
	}
	const contextWindow = positiveLimit(spec.contextWindow, 128_000, "contextWindow");
	if (
		spec.maxContextWindow !== undefined &&
		(!Number.isFinite(spec.maxContextWindow) ||
			spec.maxContextWindow <= 0 ||
			(contextWindow !== null && spec.maxContextWindow < contextWindow))
	) {
		throw new Error("maxContextWindow must be positive and no smaller than contextWindow.");
	}
	const compat = { ...spec.compat };
	return {
		...spec,
		api: api as TApi,
		name: spec.name ?? spec.id,
		identity: spec.identity ?? { class: "unknown" },
		reasoning: spec.reasoning ?? spec.thinking !== undefined,
		input: spec.input ? [...spec.input] : ["text"],
		contextWindow,
		maxTokens: positiveLimit(spec.maxTokens, 8192, "maxTokens"),
		cost: spec.cost ? { ...spec.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat,
		compatConfig: compat,
	};
}
