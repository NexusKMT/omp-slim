import { describe, expect, it } from "bun:test";
import { formatChecksums } from "./ci-release-checksums";

describe("formatChecksums", () => {
	it("sorts entries by basename and formats as `sha256sum -c`-compatible lines", () => {
		const output = formatChecksums([
			{ name: "omp-linux-x64", sha256: "b".repeat(64) },
			{ name: "omp-darwin-arm64", sha256: "a".repeat(64) },
		]);
		expect(output).toBe(`${"a".repeat(64)}  omp-darwin-arm64\n${"b".repeat(64)}  omp-linux-x64\n`);
	});

	it("returns an empty string for no entries", () => {
		expect(formatChecksums([])).toBe("");
	});
});
