import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { buildBrowserNavigationHeaders } from "./browser-headers";

/** HTML response from an ordinary HTTP request. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

/** Controls HTTP fetching with browser-compatible navigation headers. */
export interface HtmlFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	randomizeHeaders?: boolean;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
}

export async function fetchHtmlPage(url: string, options: HtmlFetchOptions): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}
