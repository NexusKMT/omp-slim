import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "@oh-my-pi/pi-tui/fuzzy";

describe("fuzzy scoring with a shadowed occurrence", () => {
	it("keeps the whole-word bonus when an earlier word merely contains the query", () => {
		const plain = fuzzyMatch("image", "image provider");
		const shadowed = fuzzyMatch("image", "reimage image provider");

		expect(plain.matches).toBe(true);
		expect(shadowed.matches).toBe(true);
		// "reimage image provider" contains "image" as a standalone word, so it must
		// score in the same class as "image provider" — not hundreds of points worse
		// just because "reimage" holds an earlier, non-qualifying occurrence.
		expect(shadowed.score).toBeLessThan(plain.score + 100);
	});

	it("ranks an exact standalone word above a candidate that only shares a prefix", () => {
		// "reimage image provider" contains the whole word "image";
		// "imagemagick tool" does not contain it as a word at all.
		const ranked = fuzzyFilter(["reimage image provider", "imagemagick tool"], "image", item => item);

		expect(ranked[0]).toBe("reimage image provider");
	});

	it("keeps the compact word-start bonus when an earlier occurrence is mid-word", () => {
		const plain = fuzzyMatch("statusline", "status line");
		const shadowed = fuzzyMatch("statusline", "mystatuslinex status line");

		expect(plain.matches).toBe(true);
		expect(shadowed.matches).toBe(true);
		expect(shadowed.score).toBeLessThan(plain.score + 100);
	});

	it("keeps the multi-word phrase bonus when an earlier occurrence is mid-word", () => {
		const plain = fuzzyMatch("gpt 5", "gpt 5");
		const shadowed = fuzzyMatch("gpt 5", "xgpt 5x gpt 5");

		expect(plain.matches).toBe(true);
		expect(shadowed.matches).toBe(true);
		expect(shadowed.score).toBeLessThan(plain.score + 100);
	});

	it("does not invent a bonus when every occurrence is mid-word", () => {
		// "line" never starts a word here, so it must stay in the weak-match band.
		const weak = fuzzyMatch("line", "multiline input mode");
		const strong = fuzzyMatch("line", "line height");

		expect(weak.matches).toBe(true);
		expect(strong.score).toBeLessThan(weak.score - 500);
	});

	it("does not invent a bonus when a shadowed occurrence also fails to qualify", () => {
		const none = fuzzyMatch("image", "reimage ximagey");
		const weak = fuzzyMatch("image", "multiimage bar");

		expect(none.score).toBeGreaterThan(-500);
		expect(weak.score).toBeGreaterThan(-500);
	});
});
