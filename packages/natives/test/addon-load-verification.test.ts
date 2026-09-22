/**
 * Regression for a native build that installs an addon the host loader cannot
 * load. `scripts/bazel-natives.ts` copied whatever the backend produced into
 * `packages/natives/native/` and reported `installed …` with no check that the
 * bytes are loadable, so a backend that emits a Mach-O/ELF the host rejects
 * still exits 0. The failure then surfaced far away — the first consumer to
 * import the runtime died with a bare `Failed to load pi_natives native addon`
 * naming the loader, not the build.
 *
 * Observed on macOS 26 → 27 (darwin-arm64): the addon from one backend stopped
 * loading with `mis-aligned LINKEDIT string pool` while the other backend's
 * addon of the same size and symbol count loaded, and nothing in the build
 * distinguished them. `verifyHostAddonLoads` turns that into an immediate,
 * attributable build failure.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ADDON_LOAD_FAILURE_EXPLANATION,
	type HostInfo,
	hostProbeFilename,
	verifyHostAddonLoads,
} from "../../../scripts/bazel-natives";

async function failureOf(operation: Promise<void>): Promise<unknown> {
	return operation.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("verifyHostAddonLoads", () => {
	test("rejects an installed addon the host loader refuses, naming the file and the loader message", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-addon-load-"));
		const addon = path.join(directory, `pi_natives.${process.platform}-${process.arch}.node`);
		// Not a shared library: any host loader refuses it, which is the whole
		// class this guard exists for — bytes that install fine and load never.
		await writeFile(addon, "this is not a shared library\n");

		try {
			const failure = await failureOf(verifyHostAddonLoads(addon));

			expect(failure).toBeInstanceOf(Error);
			const message = failure instanceof Error ? failure.message : String(failure);
			expect(message).toContain(path.basename(addon));
			expect(message).toContain(`${process.platform}-${process.arch}`);
			// The loader's own output is the whole point of the message: without
			// it an operator cannot tell a rejected signature from a malformed
			// image. Everything but the header and our closing sentence is that
			// output, so assert on what is left rather than on total length.
			const loaderOutput = message.split("\n").slice(1).join("\n").replace(ADDON_LOAD_FAILURE_EXPLANATION, "");
			expect(loaderOutput.trim()).not.toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("accepts the addon this checkout actually loads", async () => {
		const addon = path.join(import.meta.dir, "..", "native", `pi_natives.${process.platform}-${process.arch}.node`);
		if (!(await Bun.file(addon).exists())) return; // no built addon in this checkout

		expect(await failureOf(verifyHostAddonLoads(addon))).toBeUndefined();
	});
});

describe("hostProbeFilename", () => {
	const glibcArm64: HostInfo = { platform: "linux", arch: "arm64", avx2: false };
	const glibcX64Baseline: HostInfo = { platform: "linux", arch: "x64", avx2: false };

	test("never probes a musl addon on a glibc host, though both spell the filename the same", () => {
		// The release matrix installs //:natives-linux-musl-arm64 on a glibc
		// runner, and its output is named pi_natives.linux-arm64.node — the very
		// name the host's own target uses. Probing it dlopens a musl image on
		// glibc, which fails on the loader ("libc.so: cannot open shared object
		// file") and would turn a valid artifact into a failed release build.
		expect(hostProbeFilename(["linux-musl-arm64"], glibcArm64)).toBeNull();
		expect(hostProbeFilename(["linux-musl-x64-baseline"], glibcX64Baseline)).toBeNull();
	});

	test("probes the host's own target, however it was requested", () => {
		expect(hostProbeFilename(["linux-arm64"], glibcArm64)).toBe("pi_natives.linux-arm64.node");
		expect(hostProbeFilename(["host"], glibcArm64)).toBe("pi_natives.linux-arm64.node");
		expect(hostProbeFilename(["linux-x64-baseline"], glibcX64Baseline)).toBe("pi_natives.linux-x64-baseline.node");
	});

	test("skips cross-compiled targets and an ISA the host cannot run", () => {
		expect(hostProbeFilename(["win32-x64-baseline", "darwin-arm64"], glibcArm64)).toBeNull();
		// A baseline-only host never claims the modern x64 addon as its own.
		expect(hostProbeFilename(["linux-x64-modern"], glibcX64Baseline)).toBeNull();
	});
});
