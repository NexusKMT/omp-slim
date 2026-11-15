import { describe, expect, test } from "bun:test";
import { editDescription } from "@oh-my-pi/pi-natives";
import { editDescriptionCompact, resolveEditToolDescription } from "@oh-my-pi/pi-coding-agent/edit";

describe("editDescriptionCompact", () => {
	test("renders the compact prompt for modes with a compact variant", () => {
		const compact = editDescriptionCompact("hashline");
		if (!compact) throw new Error("hashline should have a compact variant");
		expect(compact.startsWith("Hashline patches.")).toBe(true);
		expect(compact).not.toContain("<anti-patterns>");
		// Density changes, language does not: every PUT/CUT/REM/MV op stays
		// expressible in the compact rendering.
		expect(compact).toContain("PUT N.=M:");
		expect(compact).toContain("CUT N.=M");
		expect(compact).toContain("`REM`");
		expect(compact).toContain("MV DEST");
		expect(compact.length).toBeLessThan(editDescription("hashline").length);
	});
});

describe("resolveEditToolDescription", () => {
	test("keeps the full prompt", () => {
		const full = resolveEditToolDescription("hashline");
		expect(full).toBe(editDescription("hashline").trimEnd());
	});

	test("falls back to the full prompt for modes without a compact variant", () => {
		const full = resolveEditToolDescription("replace");
		// No compact variant exists for replace: the compact selector is undefined.
		expect(editDescriptionCompact("replace")).toBeUndefined();
		// The full prompt renders unchanged, preserving the first description line.
		expect(full).toContain(editDescription("replace").split("\n")[0]);
	});
});
