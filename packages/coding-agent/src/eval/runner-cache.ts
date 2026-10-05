/**
 * Shared on-disk staging for subprocess kernel runner scripts.
 *
 * Each language kernel (Python/Julia/Ruby) ships its runner as a compiled-in
 * text asset, then stages it under a per-user directory in `os.tmpdir()` so
 * the interpreter can load it as a normal file. Staging is cached per language
 * directory so repeated kernel starts within a process avoid redundant writes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Memoized staged path per cache directory. The value is re-validated on every
// call: a tmpdir sweep (e.g. macOS `periodic daily clean_tmps`) or any external
// clear must self-heal within a long-lived process, not only across restarts.
const stagedPaths = new Map<string, string>();

/**
 * Stage `script` under `os.tmpdir()/<dirName>-<uid>` and return the runner path.
 *
 * The directory is per-uid because `os.tmpdir()` is shared between accounts: a
 * single shared name lets whichever account creates it first own it, and every
 * other account's runner write then fails with EACCES.
 *
 * The staged path is memoized per `dirName` but re-checked with `fs.existsSync`
 * before reuse, so a runner deleted mid-session is re-written on the next call
 * instead of handing back a path to a missing file (issue #8140).
 *
 * @param dirName Cache subdirectory prefix under the OS temp dir (unique per language).
 * @param ext Runner file extension without the dot (e.g. `py`).
 * @param script Runner source, hashed to key the cached file per version.
 */
export async function stageRunnerScript(dirName: string, ext: string, script: string): Promise<string> {
	const memoized = stagedPaths.get(dirName);
	if (memoized && fs.existsSync(memoized)) return memoized;
	const uid = process.getuid?.();
	const dir = path.join(os.tmpdir(), uid === undefined ? dirName : `${dirName}-${uid}`);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const hash = Bun.hash(script).toString(36);
	const target = path.join(dir, `runner-${hash}.${ext}`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, script);
	}
	stagedPaths.set(dirName, target);
	return target;
}
