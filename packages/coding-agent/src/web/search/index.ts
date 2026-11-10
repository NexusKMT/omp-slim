/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, DeepSeek, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { formatAge, formatCount, prompt, truncate } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getGroundedSearchProvider,
	getSearchProvider,
	isRegisteredSearchEngine,
	type SearchProvider,
	type SearchProviderFailure,
} from "./provider";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchFailureDetail,
	type SearchEngineId,
	type SearchResponse,
	type SearchResultDetails,
} from "./types";

import { cfgProvidersAntigravityEndpoint, cfgProvidersWebSearchTimeoutSeconds } from "../../session/settings";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	engine?: SearchEngineId;
}

/** Format response for LLM consumption. `notes` lead the output (e.g. relaxed-constraint warnings). */
function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) {
		parts.push(`Note: ${note}`);
	}

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncate(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncate(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncate(query, 120)}`);
		}
	}

	return parts.join("\n");
}

/** Longest failure reason a fallback note quotes, the cap source snippets get; provider errors can carry whole response bodies. */
const MAX_FALLBACK_REASON_CHARS = 240;

/** Failed candidates as tool details record them and the fallback note quotes them: reason flattened and capped. */
function failureDetails(failures: readonly SearchProviderFailure[]): SearchFailureDetail[] {
	return failures.map(({ provider, error }): SearchFailureDetail => {
		const reason = formatSearchProviderFailure(error, provider).replace(/\s+/g, " ").trim().replace(/\.$/, "");
		return {
			provider: provider.id,
			label: provider.label,
			reason: truncate(reason, MAX_FALLBACK_REASON_CHARS),
			...(error instanceof SearchProviderError && error.status !== undefined ? { status: error.status } : {}),
		};
	});
}

/**
 * Note naming the candidates that failed before `served` answered. Without it a
 * fallback engine's results read as the preferred provider's, e.g. web pages
 * standing in for an X search.
 */
function fallbackNotes(failed: readonly SearchFailureDetail[], served: { label: string }): string[] {
	if (failed.length === 0) return [];
	return [`answered by ${served.label} after ${failed.map(f => `${f.label} failed (${f.reason})`).join(" and ")}`];
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	/** The only chat model hosted search may use. */
	sessionModel?: Model<Api>;
	signal?: AbortSignal;
}

interface SearchCandidate {
	model: Model<Api>;
	engine?: SearchEngineId;
	explicit: boolean;
}

/** Search transports never select another chat model or honor retired model-role settings. */
function searchCandidates(
	params: SearchQueryParams,
	modelRegistry: ModelRegistry,
	sessionModel: Model<Api> | undefined,
): SearchCandidate[] {
	if (Object.hasOwn(params, "model")) throw new Error("Web search model overrides are not supported.");
	if (params.engine && !isRegisteredSearchEngine(params.engine)) throw new Error("Unknown HTTP search engine.");
	// Preserve the existing automatic retrieval routes; paid opt-in engines remain explicit.
	const engines: readonly SearchEngineId[] = params.engine
		? [params.engine]
		: ["parallel", "exa", "firecrawl", "searxng", "startpage", "duckduckgo", "ecosia", "google", "mojeek", "public"];
	const candidates: SearchCandidate[] = [];
	if (!params.engine && sessionModel?.webSearch && modelKind(sessionModel) === "chat") {
		candidates.push({ model: sessionModel, explicit: false });
	}
	for (const engine of engines) {
		const model = modelRegistry.find("web", engine);
		if (!model) continue;
		const candidate = { model, engine, explicit: params.engine !== undefined };
		if (!params.engine && engine === "parallel") candidates.unshift(candidate);
		else candidates.push(candidate);
	}
	return candidates;
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, sessionId, signal } = options;
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, undefined, { settings });
	const candidates = searchCandidates(params, modelRegistry, options.sessionModel);
	const parsedQuery = parseSearchQuery(params.query);

	// Invariant across candidates; resolve once before walking the role chain.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(settings);
	} catch {
		antigravityEndpointMode = undefined;
	}

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = cfgProvidersWebSearchTimeoutSeconds.get(settings);
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {
		// Preserve the default for one-shot callers that do not initialize Settings.
	}

	const failures: SearchProviderFailure[] = [];
	let availableProviderCount = 0;
	let lastProvider: { id: string; label: string } | undefined;
	let failedResponseProvider: SearchResponse["provider"] = "none";
	for (const candidate of candidates) {
		let provider: SearchProvider | undefined;
		const candidateMeta = { id: candidate.model.id, label: candidate.model.name };
		lastProvider = candidateMeta;
		try {
			const model = candidate.model;
			if (candidate.engine) {
				provider = await getSearchProvider(candidate.engine);
			} else if (model.webSearch) {
				provider = await getGroundedSearchProvider(model.webSearch);
			} else {
				throw new Error(`Current model ${model.provider}/${model.id} does not support web search`);
			}
			lastProvider = provider;
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage, model)
				: await provider.isAvailable(authStorage, model);
			if (!available && !candidate.explicit) continue;
			if (!available && candidate.explicit) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or use automatic HTTP search.`,
				);
			}
			availableProviderCount++;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				timeoutMs,
				authStorage,
				model,
				modelRegistry,
				explicit: candidate.explicit,
				sessionId,
				antigravityEndpointMode,
			});

			// A host that silently drops the hosted search tool still answers from the
			// model's weights; without sources that answer is not a search result.
			if (!candidate.engine && response.sources.length === 0 && !response.citations?.length) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} returned no sources; ${model.provider}/${model.id} may not support hosted web search.`,
					204,
				);
			}

			// Lenient constraint pass over whatever the provider returned: enforce
			// site:/inurl:/intitle:/filetype:/date directives the provider could
			// not (or only partially) honor natively, relaxing any dimension that
			// would wipe out every result. Citations/answer text stay untouched.
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			const failed = failureDetails(failures);
			const text = formatForLLM(finalResponse, [...fallbackNotes(failed, provider), ...constraintNotes]);

			return {
				content: [{ type: "text" as const, text }],
				details: failed.length > 0 ? { response: finalResponse, failures: failed } : { response: finalResponse },
			};
		} catch (error) {
			// Surface user-initiated cancellation immediately so the session sees
			// a clean abort instead of a generic "all providers failed" message.
			// Without this, an AbortError from `fetch()` is treated as a provider
			// failure and the loop falls through to the next provider (or to the
			// summary error), masking the cancellation.
			throwIfAborted(signal);
			failedResponseProvider = provider?.id ?? "none";
			failures.push({ provider: provider ?? candidateMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = "No HTTP search engine or supported current-model search is available.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: failedResponseProvider, sources: [] },
			error: message,
			failures: failureDetails(failures),
		},
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		sessionModel?: Model<Api>;
		signal?: AbortSignal;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry: options.modelRegistry,
			sessionId: options.sessionId,
			sessionModel: options.sessionModel,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/** Description without the X operators, for hosts without a model registry. */
const plainDescription = prompt.render(webSearchDescription);

/** Search HTTP engines or the current model's hosted search capability. */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchResultDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/** X-only operators are advertised only when this session itself uses an X-capable model. */
	get description(): string {
		return prompt.render(webSearchDescription, { xSearch: this.#session.getActiveModel?.()?.webSearch === "xai" });
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchResultDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			sessionModel: this.#session.getActiveModel?.(),
			signal,
		});
	}
}

/** Web search tool as CustomTool for consumers embedding the custom-tool API. */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchResultDetails> = {
	name: "web_search",
	label: "Web Search",
	description: plainDescription,
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			sessionModel: ctx.model,
			signal,
		});
	},
};

export function getSearchTools(): CustomTool<typeof webSearchSchema, SearchResultDetails>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
