/**
 * Regression for a native build that installs an addon the host loader cannot
 * load. A backend that emits a Mach-O/ELF the host rejects can still exit 0,
 * so the failure surfaces far away — the first consumer to import the runtime
 * dies with a bare `Failed to load pi_natives native addon` naming the loader,
 * not the build.
 *
 * Observed on macOS 26 → 27 (darwin-arm64): an addon stopped loading with
 * `mis-aligned LINKEDIT string pool` while another build of the same size and
 * symbol count loaded, and nothing in the build distinguished them.
 * `verifyHostAddonLoads` turns that into an immediate, attributable build
 * failure.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADDON_LOAD_FAILURE_EXPLANATION, verifyHostAddonLoads } from "../scripts/verify-addon";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import { hasVersionStampSlot, stampNativeVersion } from "../../../scripts/stamp-native-version";

// x64 addon filenames carry an ISA suffix (-modern/-baseline), so the name must
// come from the same resolver the build uses, not `${platform}-${arch}`.
const hostAddon = path.join(
	import.meta.dir,
	"..",
	"native",
	resolveLocalHostAddon({ platform: process.platform, arch: process.arch, avx2: detectHostAvx2Support() }).filename,
);

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

	test.skipIf(!existsSync(hostAddon))("accepts the addon this checkout actually loads", async () => {
		expect(await failureOf(verifyHostAddonLoads(hostAddon))).toBeUndefined();
	});

	// The compiled addon, not the Rust source, is the contract: a slot the stamp
	// tool can find and the addon then reports back. Skipped while the checkout
	// only has a prebuilt addon from before the stamp slot existed.
	test.skipIf(!existsSync(hostAddon) || !hasVersionStampSlot(readFileSync(hostAddon)))(
		"requires the loaded addon to report the version stamped into it",
		async () => {
			const directory = await mkdtemp(path.join(tmpdir(), "omp-addon-load-"));
			const addon = path.join(directory, path.basename(hostAddon));
			try {
				await copyFile(hostAddon, addon);
				await stampNativeVersion(addon, "0.0.0-probe");

				expect(await failureOf(verifyHostAddonLoads(addon, undefined, "0.0.0-probe"))).toBeUndefined();
				const mismatch = await failureOf(verifyHostAddonLoads(addon, undefined, "9.9.9"));
				expect(mismatch instanceof Error ? mismatch.message : "").toContain(
					'addon reports build version "0.0.0-probe", expected "9.9.9"',
				);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	// A FIFO with no writer blocks the loader's open() forever: a stand-in for
	// an addon whose init hangs.
	test("fails a load that never finishes instead of hanging the build", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-addon-load-"));
		const addon = path.join(directory, "pi_natives.hang.node");
		expect(Bun.spawnSync(["mkfifo", addon]).exitCode).toBe(0);

		try {
			const failure = await failureOf(verifyHostAddonLoads(addon, 500));

			expect(failure).toBeInstanceOf(Error);
			expect(failure instanceof Error ? failure.message : "").toContain("did not finish within 0.5s");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
