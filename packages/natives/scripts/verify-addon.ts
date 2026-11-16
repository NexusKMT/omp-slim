/**
 * Load-probe a freshly built host addon.
 *
 * A cross-compiled addon cannot be probed here, but a host-platform one can,
 * and an addon the host loader rejects is worse than a failed build: it
 * installs cleanly, so the failure surfaces much later as a bare
 * `process.dlopen` error in whatever first imports the runtime, with nothing
 * pointing back at the build that produced it. Loading happens in a child so a
 * successful probe does not keep the file mapped in this process.
 */

import * as path from "node:path";

/** Trailing sentence of a probe failure; the loader's own output precedes it. */
export const ADDON_LOAD_FAILURE_EXPLANATION =
	"The addon was produced and installed successfully, so this is a defect in the build that made it, " +
	"not in the loader that rejected it.";

/** Upper bound on one load probe; loading runs the addon's init code, which must not hang the build. */
export const ADDON_LOAD_PROBE_TIMEOUT_MS = 60_000;

/**
 * Confirm a freshly installed host addon can actually be loaded.
 *
 * With `expectedVersion`, the loaded addon must also report it through
 * `__piNativesBuildVersion()`: proof the Rust stamp slot and the stamp tool
 * agree on magic and layout, observed on the compiled bytes.
 */
export async function verifyHostAddonLoads(
	destPath: string,
	timeoutMs: number = ADDON_LOAD_PROBE_TIMEOUT_MS,
	expectedVersion?: string,
): Promise<void> {
	const versionCheck =
		expectedVersion === undefined
			? ""
			: `const reported = typeof m.exports.__piNativesBuildVersion === "function" ? m.exports.__piNativesBuildVersion() : undefined; ` +
				`if (reported !== ${JSON.stringify(expectedVersion)}) { console.error("addon reports build version " + JSON.stringify(reported) + ", expected " + ${JSON.stringify(JSON.stringify(expectedVersion))}); process.exit(1); }`;
	const probe =
		`const m = { exports: {} }; try { process.dlopen(m, ${JSON.stringify(destPath)}); } ` +
		"catch (error) { console.error(error && error.message ? error.message : String(error)); process.exit(1); } " +
		versionCheck;
	const proc = Bun.spawn([process.execPath, "-e", probe], { stdout: "ignore", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	let exitCode: number;
	let stderr: string;
	try {
		[exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	} finally {
		clearTimeout(timer);
	}
	const header = `built addon ${path.basename(destPath)} cannot be loaded on this host (${process.platform}-${process.arch})`;
	if (timedOut) {
		throw new Error(
			`${header}: loading did not finish within ${timeoutMs / 1000}s.\n${ADDON_LOAD_FAILURE_EXPLANATION}`,
		);
	}
	if (exitCode === 0) return;
	throw new Error(`${header}:\n${stderr.trim()}\n${ADDON_LOAD_FAILURE_EXPLANATION}`);
}
