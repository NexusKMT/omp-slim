import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { formatCompact, formatCost, formatInteger } from "../src/client/data/formatters";

// Simulate a browser whose default locale is tr-TR, where compact "B" means
// "bin" (thousand) and "," is the decimal separator. Formatters that fall back
// to the default locale would render `546 B` and `$38.003,33` here.
const nativeToLocaleString = Number.prototype.toLocaleString;

describe("dashboard number formatting", () => {
	beforeAll(() => {
		Number.prototype.toLocaleString = function (
			this: number,
			locales?: Intl.LocalesArgument,
			options?: Intl.NumberFormatOptions,
		) {
			return nativeToLocaleString.call(this, locales ?? "tr-TR", options);
		};
	});

	afterAll(() => {
		Number.prototype.toLocaleString = nativeToLocaleString;
	});

	it("ignores the browser locale so figures match the English UI", () => {
		expect(formatInteger(435_087)).toBe("435,087");
		expect(formatCompact(546_000)).toBe("546K");
		expect(formatCompact(1_400_000_000)).toBe("1.4B");
		expect(formatCost(38_003.33)).toBe("$38,003.33");
		expect(formatCost(0.0192, 4)).toBe("$0.0192");
	});
});
