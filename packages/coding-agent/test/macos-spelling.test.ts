import { describe, expect, it, mock } from "bun:test";
import { MacOSSpellingProvider, type SpellingBackend } from "../src/modes/macos-spelling";

function backend(overrides: Partial<SpellingBackend>): SpellingBackend {
	return {
		isAvailable: () => true,
		checkSpelling: () => [],
		completeWord: () => [],
		autocorrectWord: () => null,
		...overrides,
	};
}

describe("macOS spelling feature gates", () => {
	it("enables typo detection without enabling autocomplete or autocorrect", () => {
		const completeWord = mock(() => ["received"]);
		const autocorrectWord = mock(() => "received");
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling: () => [{ start: 0, length: 8 }], completeWord, autocorrectWord }),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });

		expect(provider.decorateTypos("recieved")).toBe(
			"\x1b[4:3m\x1b[58:2::255:95:95mrecieved\x1b[4:0m\x1b[59m",
		);
		expect(provider.getWordCompletion(["recieved"], 0, 8)).toBeNull();
		expect(provider.tryAutocorrect("recieved ")).toBeNull();
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables word autocomplete without enabling typo detection or autocorrect", () => {
		const checkSpelling = mock(() => [{ start: 4, length: 5 }]);
		const autocorrectWord = mock(() => "weather");
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord: () => ["weather"], autocorrectWord }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: true, autocorrect: false });

		expect(provider.decorateTypos("The weath")).toBe("The weath");
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBe("er");
		expect(provider.tryAutocorrect("weath ")).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables autocorrect without enabling typo detection or autocomplete", () => {
		const checkSpelling = mock(() => [{ start: 0, length: 10 }]);
		const completeWord = mock(() => ["definitely"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord: () => "definitely" }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: false, autocorrect: true });

		expect(provider.decorateTypos("definately")).toBe("definately");
		expect(provider.getWordCompletion(["definately"], 0, 10)).toBeNull();
		expect(provider.tryAutocorrect("definately ")).toEqual({ replaceLen: 11, insert: "definitely " });
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
	});

	it("skips paths, slash commands, and inline code", () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: text => [
					{ start: text.indexOf("recieved"), length: 8 },
					{ start: text.lastIndexOf("recieved"), length: 8 },
				],
				completeWord: () => ["received"],
				autocorrectWord: () => "received",
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });

		expect(provider.decorateTypos("`recieved` /tmp/recieved")).toBe("`recieved` /tmp/recieved");
		expect(provider.getWordCompletion(["/move reciev"], 0, 12)).toBeNull();
		expect(provider.tryAutocorrect("/tmp/recieved ")).toBeNull();
	});
});
