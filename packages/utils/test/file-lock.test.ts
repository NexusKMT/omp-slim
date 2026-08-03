import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock } from "../src/file-lock";
import { removeWithRetries } from "../src/temp";

const { tryAcquireLock, releaseLock, readLockInfo, getStaleLockIdentity, reapStaleLock, getLockPath } =
	__internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("file-lock token ownership (F1)", () => {
	test("releaseLock with the wrong token leaves the lock intact", async () => {
		const root = await mkRoot();
		const target = path.join(root, "data.json");
		const lockPath = getLockPath(target);

		const token = await tryAcquireLock(lockPath);
		expect(token).not.toBeNull();
		expect(typeof token).toBe("string");

		// A contender that lost a race calling release with a guessed/empty token
		// must NOT remove the rightful owner's lock.
		await releaseLock(lockPath, "not-the-real-token");

		const info = await readLockInfo(lockPath);
		expect(info).not.toBeNull();
		expect(info?.token).toBe(token!);

		// The rightful owner can still release.
		await releaseLock(lockPath, token!);
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("getStaleLockIdentity does NOT declare a freshly-created empty dir stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "race.json");
		const lockPath = getLockPath(target);

		// Simulate the precise window: mkdir succeeded for the winner but the
		// info file has not been written yet.
		await fs.mkdir(lockPath);

		const stale = await getStaleLockIdentity(lockPath, 10_000, 10_000);
		expect(stale).toBeNull();

		await removeWithRetries(lockPath);
	});

	test("a slow second reaper cannot destroy a reaped-and-reacquired lock", async () => {
		const root = await mkRoot();
		const target = path.join(root, "contested.json");
		const lockPath = getLockPath(target);

		// A dead owner's stale lock, judged stale by two contenders.
		await fs.mkdir(lockPath);
		await Bun.write(
			path.join(lockPath, "info"),
			JSON.stringify({ pid: 999_999_999, timestamp: Date.now() - 60_000, token: "dead-token" }),
		);
		const judged = await getStaleLockIdentity(lockPath, 10_000, 10_000);
		expect(judged).toMatchObject({ token: "dead-token" });

		// Reaper 1 wins: reaps and immediately re-acquires.
		await reapStaleLock(lockPath, judged!);
		const freshToken = await tryAcquireLock(lockPath);
		expect(freshToken).not.toBeNull();

		// Reaper 2 acts on its stale pre-reap judgment: it must not remove the
		// fresh owner's lock.
		await reapStaleLock(lockPath, judged!);

		const info = await readLockInfo(lockPath);
		expect(info?.token).toBe(freshToken!);

		// The fresh owner can still release normally.
		await releaseLock(lockPath, freshToken!);
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("concurrent reapers of a vanished lock are a no-op", async () => {
		const root = await mkRoot();
		const target = path.join(root, "gone.json");
		const lockPath = getLockPath(target);

		await fs.mkdir(lockPath);
		await Bun.write(
			path.join(lockPath, "info"),
			JSON.stringify({ pid: 999_999_999, timestamp: Date.now() - 60_000, token: "dead-token" }),
		);
		const judged = await getStaleLockIdentity(lockPath, 10_000, 10_000);
		await reapStaleLock(lockPath, judged!);
		// Second reap of the already-removed lock must not throw or recreate it.
		await reapStaleLock(lockPath, judged!);
		expect(await readLockInfo(lockPath)).toBeNull();
		expect(await fs.stat(lockPath).catch(() => null)).toBeNull();
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						// Widen the critical-section window so any concurrency leak
						// surfaces as a lost update.
						await Bun.sleep(2);
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);
});
