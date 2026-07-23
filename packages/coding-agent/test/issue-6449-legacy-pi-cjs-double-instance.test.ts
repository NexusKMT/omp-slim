import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

const COMPAT_MODULE = Bun.resolveSync(
	"@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat",
	import.meta.dir,
);

describe("issue #6449: legacy pi CommonJS graph across double instantiation", () => {
	let dupPath: string | undefined;
	let tempDir: TempDir | undefined;

	afterEach(() => {
		if (dupPath) {
			fs.rmSync(dupPath, { force: true });
			dupPath = undefined;
		}
		if (tempDir) {
			tempDir.removeSync();
			tempDir = undefined;
		}
	});

	it("keeps the host graph bridge after a second legacy-pi-compat instance loads", async () => {
		installLegacyPiSpecifierShim();

		tempDir = TempDir.createSync("@issue-6449-");
		const extDir = tempDir.absolute();
		fs.writeFileSync(path.join(extDir, "dep.cjs"), 'module.exports = { greet: () => "hello" };\n');
		const entryPath = path.join(extDir, "index.ts");
		// Import the CommonJS dependency lazily so the graph scan records it into
		// the CommonJS graph at load time, but its bridge only evaluates when
		// useDep() runs — after the second instance has re-registered the global.
		fs.writeFileSync(
			entryPath,
			`export async function useDep(): Promise<string> {\n\tconst mod = await import("./dep.cjs");\n\treturn (mod as { greet(): string }).greet();\n}\n`,
		);

		const ns = (await loadLegacyPiModule(entryPath)) as { useDep(): Promise<string> };

		// A source-link install serves the pi-coding-agent root shim from src/, so
		// an extension's import evaluates a SECOND on-disk instance of this module
		// with empty graph state. Reproduce that distinct module identity by
		// copying the module beside the original (identical relative imports
		// resolve to the same shared deps) and importing the copy, which re-runs
		// its top-level global registration. A regression to an unconditional
		// `Reflect.set` clobbers the host bridge and makes useDep() throw
		// "Missing graph-owned CommonJS definition".
		dupPath = path.join(path.dirname(COMPAT_MODULE), "issue-6449-compat-dup.ts");
		fs.copyFileSync(COMPAT_MODULE, dupPath);
		await import(Bun.pathToFileURL(dupPath).href);

		expect(await ns.useDep()).toBe("hello");
	});
});
