import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stageRunnerScript } from "../src/eval/runner-cache";

// stageRunnerScript memoizes the staged path per cache directory, but the warm
// path must re-validate with fs.existsSync so a tmpdir sweep (macOS periodic
// `clean_tmps`) or any external clear self-heals within a long-lived process
// instead of returning a path to a missing file (issue #8140).
describe("stageRunnerScript re-validation", () => {
	const dirs: string[] = [];

	function uniqueDir() {
		const name = `omp-runner-cache-test-${process.pid}-${dirs.length}-${Date.now()}`;
		dirs.push(name);
		return name;
	}

	// Mirrors stageRunnerScript's per-uid directory naming.
	function stagingDir(name: string) {
		const uid = process.getuid?.();
		return path.join(os.tmpdir(), uid === undefined ? name : `${name}-${uid}`);
	}

	afterEach(() => {
		for (const name of dirs) {
			fs.rmSync(stagingDir(name), { recursive: true, force: true });
			fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	it("re-stages the runner after the cached file is deleted mid-session", async () => {
		const dirName = uniqueDir();
		const script = "print('staged runner')\n";

		const first = await stageRunnerScript(dirName, "py", script);
		expect(fs.existsSync(first)).toBe(true);

		// Simulate a mid-session tmpdir sweep clearing the whole cache dir.
		fs.rmSync(stagingDir(dirName), { recursive: true, force: true });
		expect(fs.existsSync(first)).toBe(false);

		// Same process, memo still set: the warm path must fall through and
		// re-stage instead of handing back the now-missing path.
		const second = await stageRunnerScript(dirName, "py", script);
		expect(second).toBe(first);
		expect(fs.existsSync(second)).toBe(true);
		expect(await Bun.file(second).text()).toBe(script);
	});

	it("reuses the memoized path while the file still exists", async () => {
		const dirName = uniqueDir();
		const script = "puts 'hi'\n";

		const first = await stageRunnerScript(dirName, "rb", script);
		const second = await stageRunnerScript(dirName, "rb", script);

		expect(second).toBe(first);
		expect(first.endsWith(".rb")).toBe(true);
		expect(fs.existsSync(second)).toBe(true);
	});

	// The shared, un-suffixed tmpdir name may be owned by another account (e.g.
	// root created it 0755 first); staging must not write into it, or every other
	// user's Python eval fails with EACCES. A non-writable dir stands in for the
	// foreign owner; root bypasses mode bits and Windows has no getuid, so skip both.
	it.skipIf(process.getuid?.() === undefined || process.getuid?.() === 0)(
		"stages outside a shared dir the current user cannot write",
		async () => {
			const dirName = uniqueDir();
			const shared = path.join(os.tmpdir(), dirName);
			fs.mkdirSync(shared, { mode: 0o555 });

			const staged = await stageRunnerScript(dirName, "py", "print('ok')\n");

			expect(path.dirname(staged)).not.toBe(shared);
			expect(await Bun.file(staged).text()).toBe("print('ok')\n");
			expect(fs.statSync(path.dirname(staged)).mode & 0o777).toBe(0o700);
		},
	);
});
