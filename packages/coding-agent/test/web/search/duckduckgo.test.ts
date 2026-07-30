import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { localeToKl, searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";
import { parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";

describe("localeToKl", () => {
	it("maps region-qualified locales into DDG region-language order", () => {
		expect(localeToKl("de-de")).toBe("de-de");
		expect(localeToKl("fr-fr")).toBe("fr-fr");
		// asymmetric locales swap: our language-region -> DDG region-language
		expect(localeToKl("en-us")).toBe("us-en");
		expect(localeToKl("pt-br")).toBe("br-pt");
		expect(localeToKl("zh-cn")).toBe("cn-zh");
	});

	it("applies the gb->uk region alias DDG uses for the United Kingdom", () => {
		expect(localeToKl("en-gb")).toBe("uk-en");
	});

	it("normalizes case and underscore separators", () => {
		expect(localeToKl("EN_US")).toBe("us-en");
		expect(localeToKl("De-DE")).toBe("de-de");
	});

	it("returns undefined for language-only, empty, or malformed values", () => {
		expect(localeToKl(undefined)).toBeUndefined();
		expect(localeToKl("de")).toBeUndefined();
		expect(localeToKl("en")).toBeUndefined();
		expect(localeToKl("english")).toBeUndefined();
		expect(localeToKl("")).toBeUndefined();
	});
});

describe("searchDuckDuckGo kl parameter (integration)", () => {
	const fakeAuthStorage = {} as unknown as AuthStorage;

	async function effectiveForm(query: string): Promise<URLSearchParams> {
		let body: string | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			body = init?.body as string;
			return new Response("<html><body></body></html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		};
		await searchDuckDuckGo({
			query,
			parsedQuery: parseSearchQuery(query),
			systemPrompt: "",
			authStorage: fakeAuthStorage,
			fetch: fetchMock,
		});
		return new URLSearchParams(body ?? "");
	}

	it("honors the lang: directive so distinct locales produce distinct requests", async () => {
		const de = await effectiveForm("weather lang:de-de");
		const fr = await effectiveForm("weather lang:fr-fr");
		expect(de.get("q")).toBe("weather");
		expect(de.get("kl")).toBe("de-de");
		expect(fr.get("kl")).toBe("fr-fr");
	});

	it("swaps language-region into DDG region-language order", async () => {
		const form = await effectiveForm("news lang:en-us");
		expect(form.get("kl")).toBe("us-en");
	});

	it("falls back to us-en when no lang: directive is supplied", async () => {
		const form = await effectiveForm("weather");
		expect(form.get("kl")).toBe("us-en");
	});

	it("falls back to us-en for language-only locales", async () => {
		const form = await effectiveForm("weather lang:de");
		expect(form.get("kl")).toBe("us-en");
	});
});
