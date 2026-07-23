import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyProviderGlobalsFromSettings } from "@oh-my-pi/pi-coding-agent/config/provider-globals";
import * as imageGen from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import * as webSearch from "@oh-my-pi/pi-coding-agent/web/search";

describe("applyProviderGlobalsFromSettings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reapplies valid web and image provider globals from cwd-scoped settings", () => {
		const excludeSpy = vi.spyOn(webSearch, "setExcludedSearchProviders").mockImplementation(() => {});
		const orderSpy = vi.spyOn(webSearch, "setSearchProviderOrder").mockImplementation(() => {});
		const webSpy = vi.spyOn(webSearch, "setPreferredSearchProvider").mockImplementation(() => {});
		const imageSpy = vi.spyOn(imageGen, "setPreferredImageProvider").mockImplementation(() => {});

		applyProviderGlobalsFromSettings({
			get(
				path: "providers.webSearchOrder" | "providers.webSearchExclude" | "providers.webSearch" | "providers.image",
			): unknown {
				const values: Record<string, unknown> = {
					"providers.webSearchOrder": ["perplexity", "not-a-provider", "exa"],
					"providers.webSearchExclude": ["exa", "not-a-provider", "gemini"],
					"providers.webSearch": "perplexity",
					"providers.image": "xai",
				};
				return values[path];
			},
		});

		expect(orderSpy).toHaveBeenCalledWith(["perplexity", "exa"]);
		expect(excludeSpy).toHaveBeenCalledWith(["exa", "gemini"]);
		expect(webSpy).toHaveBeenCalledWith("perplexity");
		expect(imageSpy).toHaveBeenCalledWith("xai");
	});
});
