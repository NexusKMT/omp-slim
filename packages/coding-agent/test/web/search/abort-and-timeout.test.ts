/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed". The provider wiring is
 * spot-checked on Brave; the
 * helper itself is exercised directly.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";
import { withHardTimeout } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { type SearchProviderId, type SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/auth-storage";

import { cfgProvidersWebSearchTimeoutSeconds } from "@oh-my-pi/pi-coding-agent/session/settings";

const openAuthStorages: AuthStorage[] = [];

function createSearchContext() {
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	return { authStorage };
}

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("Brave provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("hands fetch a composed signal even with no caller signal", async () => {
		const context = createSearchContext();
		context.authStorage.keys.setRuntime("brave", "brave-test-key");
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchBrave({
			query: "ping",
			fetch: fetchMock,
			authStorage: context.authStorage,
		});

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: behaviour,
		};
	}

	async function configureProviderChain(providers: provider.SearchProvider[]) {
		const primary = providers[0];
		if (!primary) throw new Error("Provider chain must contain a primary candidate");
		await Settings.init({ inMemory: true });
		const { authStorage } = createSearchContext();
		const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.find(candidate => candidate.id === id);
			return (
				match ?? {
					id: id as SearchProviderId,
					label: id,
					isAvailable: () => false,
					isExplicitlyAvailable: () => false,
					search: async () => {
						throw new Error(`Unavailable provider: ${id}`);
					},
				}
			);
		});
		return { authStorage, getProvider };
	}

	it("passes the configured provider-request timeout into the search adapter", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Configured result", url: "https://example.com/configured" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 180);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("firecrawl");
		expect(timeoutMs).toBe(180_000);
	});

	it("caps the configured provider-request timeout at five minutes", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Capped result", url: "https://example.com/capped" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 600);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(300_000);
	});

	it("uses the default provider timeout for a non-positive setting", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Default result", url: "https://example.com/default" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 0);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(60_000);
	});

	it("does not start any provider when the caller has already cancelled", async () => {
		const firstSearch = vi.fn();
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("exa", firstSearch),
			fakeProvider("firecrawl", fallbackSearch),
		]);
		const ac = new AbortController();
		ac.abort();

		await expect(runSearchQuery({ query: "anything" }, { ...context, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(firstSearch).not.toHaveBeenCalled();
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("surfaces cancellation during search without starting the next HTTP engine", async () => {
		const ac = new AbortController();
		const fallbackSearch = vi.fn();
		const firstSearch = vi.fn(async () => {
			ac.abort();
			throw new DOMException("aborted", "AbortError");
		});
		const context = await configureProviderChain([
			fakeProvider("exa", firstSearch),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		await expect(runSearchQuery({ query: "anything" }, { ...context, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(firstSearch).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures when the caller has not aborted", async () => {
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.content[0]?.text).toContain("upstream 500");
		expect(result.details.error).toContain("upstream 500");
	});

	it("falls through when the configured HTTP engine returns no renderable content", async () => {
		const emptySearch = vi.fn(async (): Promise<SearchResponse> => ({ provider: "exa", sources: [] }));
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback", snippet: "fallback body" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("exa", emptySearch),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(emptySearch).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toContain("Fallback result");
		expect(result.details.response.provider).toBe("firecrawl");
	});

	it("stops loading the HTTP engines after the preferred candidate succeeds", async () => {
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("exa", async () => ({
				provider: "exa",
				sources: [{ title: "Preferred result", url: "https://example.com/preferred" }],
			})),
			fakeProvider("duckduckgo", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("exa");
		expect(context.getProvider).toHaveBeenCalledTimes(2);
		expect(context.getProvider).toHaveBeenLastCalledWith("exa");
		expect(fallbackSearch).not.toHaveBeenCalled();
		expect(result.content[0]?.text).not.toContain("Note: answered by");
		expect(Object.hasOwn(result.details, "failures")).toBe(false);
	});

	it("advances through the HTTP engine list after the preferred candidate fails", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", "Preferred provider failed.", 500);
			}),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("firecrawl");
		expect(context.getProvider).toHaveBeenCalledTimes(3);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toStartWith(
			"Note: answered by firecrawl after exa failed (Preferred provider failed)\n",
		);
		expect(result.details.failures).toEqual([
			{ provider: "exa", label: "exa", reason: "Preferred provider failed", status: 500 },
		]);
	});

	it("records every provider in details.failures when all of them fail", async () => {
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", "Exa refused.", 204);
			}),
			fakeProvider("firecrawl", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.error).toContain("All web search providers failed");
		expect(result.details.failures).toEqual([
			{ provider: "exa", label: "exa", reason: "Exa refused", status: 204 },
			{ provider: "firecrawl", label: "firecrawl", reason: "upstream 500" },
		]);
	});

	it("flattens and caps a long multi-line failure reason in the fallback note", async () => {
		const htmlPage = `<html>\n<head><title>502 Bad Gateway</title></head>\n<body>${"x".repeat(2_000)}</body>\n</html>`;
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", `Exa API error (502): ${htmlPage}`, 502);
			}),
			fakeProvider("firecrawl", async () => ({
				provider: "firecrawl",
				sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
			})),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		const [note = ""] = (result.content[0]?.text ?? "").split("\n");
		expect(note).toStartWith(
			"Note: answered by firecrawl after exa failed (Exa API error (502): <html> <head><title>502 Bad Gateway",
		);
		expect(note).toEndWith("…)");
		expect(note.length).toBeLessThan(320);
	});

	it("treats a request HTTP engine selection as a single explicit candidate", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Hidden fallback", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", "Explicit Exa search failed.", 400);
			}),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything", engine: "exa" }, context);

		expect(result.details.error).toContain("Explicit Exa search failed.");
		expect(result.details.response.provider).toBe("exa");
		expect(context.getProvider).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});
