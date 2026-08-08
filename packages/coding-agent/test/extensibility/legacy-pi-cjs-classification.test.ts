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
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-esm-sibling", version: "1.0.0" }),
			"helper.cjs": ["const value = 42;", "module.exports = { value };"].join("\n"),
			"index.mjs": ["import helper from './helper.cjs';", "export const result = helper.value;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { result: number };
		expect(mod.result).toBe(42);
	});

	it("classifies a CJS file with require() imported from ESM as CJS", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-require-esm", version: "1.0.0" }),
			"dep.js": ["const greeting = require('./greeting.js');", "module.exports = { greeting };"].join("\n"),
			"greeting.js": ["module.exports = 'hello';"].join("\n"),
			"index.mjs": ["import dep from './dep.js';", "export const greeting = dep.greeting;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { greeting: string };
		expect(mod.greeting).toBe("hello");
	});

	it("allows ambiguous files to use inheritedKind fallback", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-ambiguous", version: "1.0.0" }),
			"shim.js": [
				"// This file has no import/export or require/module.exports",
				"// It is a side-effect-only file that gets classified via inheritedKind",
			].join("\n"),
			"index.mjs": ["import './shim.js';", "export const ok = true;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { ok: boolean };
		expect(mod.ok).toBe(true);
	});

	it("correctly loads a CJS package with exports field (playwright-core pattern)", async () => {
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

		const nodeModules = path.join(dir, "node_modules", "dual-entry-pkg");
		await fs.mkdir(nodeModules, { recursive: true });
		await fs.copyFile(path.join(dir, "package.json"), path.join(nodeModules, "package.json"));
		await fs.copyFile(path.join(dir, "index.mjs"), path.join(nodeModules, "index.mjs"));
		await fs.copyFile(path.join(dir, "index.cjs"), path.join(nodeModules, "index.cjs"));
		await fs.copyFile(path.join(dir, "core.js"), path.join(nodeModules, "core.js"));

		const entry = path.join(dir, "consumer.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { result: string };
		expect(mod.result).toBe("launched");
	});

	it("does not false-positive on CJS patterns in comments", async () => {
		// A file with CJS patterns only in comments should be classified
		// via inheritedKind, not as CJS
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-comment-fp", version: "1.0.0" }),
			"shim.js": [
				"// module.exports = { value: 999 };",
				"/* require('ignored') */",
				"export const value = 42;",
			].join("\n"),
			"index.mjs": ["import { value } from './shim.js';", "export const result = value;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { result: number };
		expect(mod.result).toBe(42);
	});

	it("detects CJS patterns outside comments", async () => {
		// A file with CJS patterns in actual code should be classified as CJS
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-real-code", version: "1.0.0" }),
			"dep.js": [
				"// This is just a comment",
				"const value = require('./value.js');",
				"module.exports = { value };",
			].join("\n"),
			"value.js": ["module.exports = 99;"].join("\n"),
			"index.mjs": ["import dep from './dep.js';", "export const result = dep.value;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { result: number };
		expect(mod.result).toBe(99);
	});
});

describe("comment stripping heuristics", () => {
	it("does not false-positive on double-slash inside URL strings", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-url-fp", version: "1.0.0" }),
			"dep.js": [
				'const api = "https://api.example.com/v1";',
				'const backup = "http://backup.example.com";',
				"module.exports = { api, backup };",
			].join("\n"),
			"index.mjs": ["import dep from './dep.js';", "export const api = dep.api;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { api: string };
		expect(mod.api).toBe("https://api.example.com/v1");
	});

	it("does not false-positive on double-slash in ftp/file/ssh URL strings", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "cjs-url-proto", version: "1.0.0" }),
			"dep.js": [
				'const ftp = "ftp://files.example.com/data";',
				'const file = "file:///local/path";',
				'const ssh = "ssh://server.example.com";',
				"module.exports = { ftp, file, ssh };",
			].join("\n"),
			"index.mjs": ["import dep from './dep.js';", "export const ftp = dep.ftp;"].join("\n"),
		});

		const entry = path.join(dir, "index.mjs");
		const mod = (await loadLegacyPiModule(entry)) as { ftp: string };
		expect(mod.ftp).toBe("ftp://files.example.com/data");
	});
});
