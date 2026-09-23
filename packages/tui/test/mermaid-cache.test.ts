import { beforeEach, describe, expect, it, mock } from "bun:test";
import { clearMermaidCache, resolveMermaidAscii } from "../src/theme/mermaid-cache.ts";

const renders: string[] = [];

// mock.module is hoisted ahead of the static import above.
mock.module("@oh-my-pi/pi-utils/mermaid-ascii", () => ({
	renderMermaidAsciiSafe(source: string, options?: { direction?: "TD" | "LR" }): string | null {
		const direction = options?.direction ?? "authored";
		renders.push(`${source}:${direction}`);
		if (source === "bad") return null;
		if (source === "wide-authored") {
			if (direction === "authored") return "AUTHORED-ALSO-WIDE\nsecond\nthird";
			if (direction === "TD") return "td\ntd\ntd";
			return "left-to-right";
		}
		if (source === "colored") {
			if (direction === "authored") return "\u001b[31mabcd\u001b[0m";
			if (direction === "TD") return "too-wide-for-four";
			return "z";
		}
		return "x";
	},
}));

describe("resolveMermaidAscii resize selection", () => {
	beforeEach(() => {
		renders.length = 0;
		clearMermaidCache();
	});

	it("keeps the authored layout when no width is given", () => {
		expect(resolveMermaidAscii("wide-authored")).toBe("AUTHORED-ALSO-WIDE\nsecond\nthird");
		expect(renders).toEqual(["wide-authored:authored"]);
	});

	it("picks the shortest fitting orientation, then switches when a resize makes it overflow", () => {
		expect(resolveMermaidAscii("wide-authored", { maxWidth: 30 })).toBe("left-to-right");
		expect(renders).toEqual(["wide-authored:authored", "wide-authored:TD", "wide-authored:LR"]);

		expect(resolveMermaidAscii("wide-authored", { maxWidth: 10 })).toBe("td\ntd\ntd");
		expect(renders).toHaveLength(3);
	});

	it("uses the narrowest layout only when nothing fits", () => {
		expect(resolveMermaidAscii("wide-authored", { maxWidth: 1 })).toBe("td\ntd\ntd");
	});

	it("measures themed ASCII without counting ANSI", () => {
		expect(resolveMermaidAscii("colored", { maxWidth: 4 })).toBe("\u001b[31mabcd\u001b[0m");
	});

	it("returns null without trying orientations when the source fails", () => {
		expect(resolveMermaidAscii("bad", { maxWidth: 80 })).toBeNull();
		expect(renders).toEqual(["bad:authored"]);
	});
});
