import type { SearchProvider } from "./providers/base";
import { getSearchProviderLabel, type SearchEngineId, SearchProviderError } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

/** Search adapters load on first use; their instances are memoized by engine id. */
type ProviderLoader = () => Promise<SearchProvider>;

type ProviderRegistry<TId extends string> = { [Id in TId]: ProviderLoader };

const PROVIDER_LOADERS: ProviderRegistry<SearchEngineId> = {
	exa: () => import("./providers/exa").then(m => new m.ExaProvider()),
	firecrawl: () => import("./providers/firecrawl").then(m => new m.FirecrawlProvider()),
	parallel: () => import("./providers/parallel").then(m => new m.ParallelProvider()),
	searxng: () => import("./providers/searxng").then(m => new m.SearXNGProvider()),
	duckduckgo: () => import("./providers/duckduckgo").then(m => new m.DuckDuckGoProvider()),
	google: () => import("./providers/google").then(m => new m.GoogleProvider()),
	ecosia: () => import("./providers/ecosia").then(m => new m.EcosiaProvider()),
	startpage: () => import("./providers/startpage").then(m => new m.StartpageProvider()),
	mojeek: () => import("./providers/mojeek").then(m => new m.MojeekProvider()),
	public: () => import("./providers/public").then(m => new m.PublicWebProvider()),
};

const providerInstances = new Map<string, Promise<SearchProvider>>();

function loadProvider(id: string, loader: ProviderLoader): Promise<SearchProvider> {
	let instance = providerInstances.get(id);
	if (!instance) {
		instance = loader();
		providerInstances.set(id, instance);
	}
	return instance;
}

/** HTTP search endpoints; none chooses or runs a chat model. */
export const HTTP_SEARCH_ENGINE_IDS = Object.keys(PROVIDER_LOADERS) as SearchEngineId[];

/** One candidate that failed during a search, in attempt order. */
export interface SearchProviderFailure {
	provider: { id: string; label: string };
	error: unknown;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: { id: string; label: string }): string {
	if (error instanceof SearchProviderError) {
		if (error.status === 401 || error.status === 403) {
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(failures: readonly SearchProviderFailure[]): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/** Whether `id` names a supported HTTP search engine. */
export function isRegisteredSearchEngine(id: string): id is SearchEngineId {
	return Object.hasOwn(PROVIDER_LOADERS, id);
}

/** Resolve an HTTP search adapter after validating its engine id. */
export function getSearchProvider(id: string): Promise<SearchProvider> {
	if (!isRegisteredSearchEngine(id)) return Promise.reject(new Error(`Unknown search provider: ${id}`));
	return loadProvider(id, PROVIDER_LOADERS[id]);
}
