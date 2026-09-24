import { describe, expect, it } from "bun:test";

/**
 * `Bun.plugin()` registrations are process-global and permanent, so the shim is
 * installed in a child process: a leaked resolve hook would change module
 * resolution for every later test in this runner.
 */
async function requireThroughShim(specifier: string): Promise<string> {
	const shimPath = new URL("../../src/extensibility/plugins/legacy-pi-compat.ts", import.meta.url).pathname;
	const source = [
		`const { installLegacyPiSpecifierShim } = await import(${JSON.stringify(shimPath)});`,
		"installLegacyPiSpecifierShim();",
		"try {",
		`	const loaded = require(${JSON.stringify(specifier)});`,
		'	console.log("OK " + Object.keys(loaded).length);',
		"} catch (err) {",
		'	console.log("ERR " + String(err).slice(0, 200));',
		"}",
	].join("\n");
	// `process.execPath` pins the child to the Bun running this test, not
	// whichever `bun` happens to be first on PATH.
	const proc = Bun.spawn([process.execPath, "-e", source], {
		cwd: new URL("../../", import.meta.url).pathname,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const stderr = err.trim();
	return stderr ? `${out.trim()}\n[stderr] ${stderr.slice(0, 500)}` : out.trim();
}

describe("legacy-pi specifier shim", () => {
	it("resolves a canonical @oh-my-pi subpath that remaps to itself", async () => {
		// Regression: the resolve hook matches `@oh-my-pi/pi-*` as well as the
		// legacy scopes, so resolving the remapped specifier called
		// `Bun.resolveSync` with a specifier this same hook matches. Bun
		// re-entered the hook and re-prefixed the namespace on every pass until
		// the import died as `NameTooLong reading "file:file:…"`, breaking every
		// `require("@oh-my-pi/pi-ai/index.js")` first-use boundary — the
		// `/login` provider selector among them.
		const output = await requireThroughShim("@oh-my-pi/pi-ai/index.js");
		expect(output).not.toContain("NameTooLong");
		expect(output.startsWith("OK ")).toBe(true);
	}, 30_000);
});
