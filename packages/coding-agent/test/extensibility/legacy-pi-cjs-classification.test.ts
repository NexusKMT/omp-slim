import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writePackage(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cjs-classification-"));
	tempRoots.push(dir);
	for (const rel in files) {
		const abs = path.join(dir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, files[rel], "utf8");
	}
	return dir;
}

describe("isCommonJsModulePath CJS classification (inheritedKind override fix)", () => {
	it("classifies a CJS file imported from an ESM sibling as CJS, not ESM", async () => {
		// Reproduces the bug: ESM index.mjs imports CJS helper.cjs via
		// `import './helper.cjs'`. The graph walk passes inheritedKind='esm'
		// which previously overrode the source-type detection, causing the
		// CJS bridge hook to not be installed.
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-esm-sibling", version: "1.0.0" }),
			"helper.cjs": ["const value = 42;", "module.exports = { value };"].join("\n"),
			"index.mjs": ["import helper from './helper.cjs';", "export const result = helper.value;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = await loadLegacyPiModule(entry);
		expect((mod as any).result).toBe(42);
	});

	it("classifies a CJS file with require() imported from ESM as CJS", async () => {
		// CJS file uses require() — should be detected by the CJS syntax check
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-require-esm", version: "1.0.0" }),
			"dep.js": ["const greeting = require('./greeting.js');", "module.exports = { greeting };"].join("\n"),
			"greeting.js": ["module.exports = 'hello';"].join("\n"),
			"index.mjs": ["import dep from './dep.js';", "export const greeting = dep.greeting;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = await loadLegacyPiModule(entry);
		expect((mod as any).greeting).toBe("hello");
	});

	it("allows ambiguous files to use inheritedKind fallback", async () => {
		// An ambiguous .js file (no import/export, no require/module.exports)
		// should fall through to inheritedKind for classification.
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-ambiguous", version: "1.0.0" }),
			"shim.js": [
				"// This file has no import/export or require/module.exports",
				"// It is a side-effect-only file that gets classified via inheritedKind",
			].join("\n"),
			"index.mjs": ["import './shim.js';", "export const ok = true;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		// Should not throw — the ambiguous file should be classified
		// via inheritedKind without crashing
		const mod = await loadLegacyPiModule(entry);
		expect((mod as any).ok).toBe(true);
	});

	it("correctly loads a CJS package with exports field (playwright-core pattern)", async () => {
		// Simulates the playwright-core pattern: ESM wrapper re-exports from CJS entry
		const dir = await writePackage({
			"package.json": JSON.stringify({
				name: "dual-entry-pkg",
				version: "1.0.0",
				exports: {
					".": {
						import: "./index.mjs",
						require: "./index.cjs",
					},
				},
			}),
			"index.cjs": ["const core = require('./core.js');", "module.exports = core;"].join("\n"),
			"core.js": ["module.exports = { launch: () => 'launched', version: '1.0.0' };"].join("\n"),
			"index.mjs": [
				"import pkg from './index.cjs';",
				"export default pkg;",
				"export const launch = pkg.launch;",
			].join("\n"),
			"consumer.mjs": ["import pkg from 'dual-entry-pkg';", "export const result = pkg.launch();"].join("\n"),
		});

		// Install the package in node_modules so the bare import resolves
		const nodeModules = path.join(dir, "node_modules", "dual-entry-pkg");
		await fs.mkdir(nodeModules, { recursive: true });
		await fs.copyFile(path.join(dir, "package.json"), path.join(nodeModules, "package.json"));
		await fs.copyFile(path.join(dir, "index.mjs"), path.join(nodeModules, "index.mjs"));
		await fs.copyFile(path.join(dir, "index.cjs"), path.join(nodeModules, "index.cjs"));
		await fs.copyFile(path.join(dir, "core.js"), path.join(nodeModules, "core.js"));

		const entry = path.join(dir, "consumer.mjs");
		const mod = await loadLegacyPiModule(entry);
		expect((mod as any).result).toBe("launched");
	});
});
