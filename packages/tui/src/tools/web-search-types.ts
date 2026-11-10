/**
 * Web search response types shared by the coding agent's search providers and
 * the transcript renderer in {@link ./web-search}. Render-free, so provider code
 * can import it without loading UI components.
 */

/**
 * Display labels for HTTP search engines. Keys are the ids providers report in
 * {@link SearchResponse.provider} and search errors.
 */
export const SEARCH_PROVIDER_LABELS = {
	parallel: "Parallel",
	zai: "Z.AI",
	exa: "Exa",
	tinyfish: "TinyFish",
	keenable: "Keenable",
	jina: "Jina",
	kagi: "Kagi",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	brave: "Brave",
	deepseek: "DeepSeek",
	kimi: "Kimi",
	synthetic: "Synthetic",
	ollama: "Ollama",
	searxng: "SearXNG",
	startpage: "Startpage",
	duckduckgo: "DuckDuckGo",
	ecosia: "Ecosia",
	google: "Google",
	mojeek: "Mojeek",
	public: "Public Web",
} as const;

/** Id of a search implementation; see {@link SEARCH_PROVIDER_LABELS}. */
export type SearchProviderId = keyof typeof SEARCH_PROVIDER_LABELS;

/** Label for a provider id; ids from older transcripts fall back to the raw id. */
export function getSearchProviderLabel(id: string): string {
	return Object.hasOwn(SEARCH_PROVIDER_LABELS, id) ? SEARCH_PROVIDER_LABELS[id as SearchProviderId] : id;
}

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (LLM-mediated providers) */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Number of web search requests made */
	searchRequests?: number;
	/** Combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | (string & {});
	/** Synthesized answer text (LLM-mediated providers) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode recorded by the provider */
	authMode?: string;
}
