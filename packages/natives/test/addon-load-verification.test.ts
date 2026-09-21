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
import { verifyHostAddonLoads } from "../../../scripts/bazel-natives";

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
			// The loader's own words are preserved: without them the operator
			// cannot tell a signature rejection from a malformed image.
			expect(message.length).toBeGreaterThan(path.basename(addon).length + 40);
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
