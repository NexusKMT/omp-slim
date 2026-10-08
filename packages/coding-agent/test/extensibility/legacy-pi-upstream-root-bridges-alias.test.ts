import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// End-to-end resolution proof for the upstream-root bridges: legacy extensions
// import the aliased package roots (`@earendil-works/pi-ai` etc.) and Bun's
// static named-export check fails the whole plugin on one missing symbol.
// pi-optchat imports `getCurrentSystemMessage` from the pi-ai root,
// `parseSkillBlock` from the pi-coding-agent root, and `compositeTuiLine`
// from the pi-tui root; each failed plugin validation before the respective
// shim bridge existed. Fixtures here import through the public legacy
// specifiers — the same path `loadLegacyPiModule` gives real extensions.

installLegacyPiSpecifierShim();

const tempRoots: string[] = [];
afterAll(async () => {
	for (const dir of tempRoots) await removeWithRetries(dir);
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-upstream-bridges-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy aliased-scope roots resolve the upstream 1.1.0 bridges", () => {
	it("resolves getCurrentSystemMessage from the @earendil-works/pi-ai root and replays tool state", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";',
				"export const replayed = getCurrentSystemMessage([",
				'  { role: "system", content: "Base.", toolsAdded: [{ name: "read", description: "r", parameters: {} }], timestamp: 5 },',
				'  { role: "system", content: "More.", timestamp: 7 },',
				"]);",
				'export const tools = getCurrentTools([{ role: "system", toolsAdded: [{ name: "read", description: "r", parameters: {} }] }]);',
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as {
			replayed: { content: string; timestamp: number; toolsAdded?: { name: string }[] } | undefined;
			tools: { name: string }[];
		};
		expect(loaded.replayed?.content).toBe("Base.\n\nMore.");
		expect(loaded.replayed?.timestamp).toBe(5);
		expect(loaded.replayed?.toolsAdded?.map(t => t.name)).toEqual(["read"]);
		expect(loaded.tools.map(t => t.name)).toEqual(["read"]);
	});

	it("resolves parseSkillBlock from the @earendil-works/pi-coding-agent root", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { parseSkillBlock } from "@earendil-works/pi-coding-agent";',
				'export const parsed = parseSkillBlock(\'<skill name="s" location="/l">\\nbody\\n</skill>\');',
				"export const miss = parseSkillBlock('no block here');",
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as {
			parsed: { name: string; content: string } | null;
			miss: null;
		};
		expect(loaded.parsed?.name).toBe("s");
		expect(loaded.parsed?.content).toBe("body");
		expect(loaded.miss).toBeNull();
	});

	it("resolves compositeTuiLine from the @earendil-works/pi-tui root", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { compositeTuiLine } from "@earendil-works/pi-tui";',
				"export const composed = compositeTuiLine('abcdefgh', 'XY', 2, 2, 8);",
			].join("\n"),
		);
		const loaded = (await loadLegacyPiModule(entry)) as { composed: string };
		// The overlay is spliced at column 2 with ANSI resets around it.
		expect(loaded.composed).toContain("XY");
		expect(loaded.composed.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abXYefgh");
	});
});
