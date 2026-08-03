/**
 * Cross-process advisory file lock shared by every package that serializes
 * access to an on-disk resource (settings writes, MCP config, security store,
 * stats sync). Locking is a `${filePath}.lock` directory — `mkdir` is atomic
 * on every platform — holding an `info` file with the owner pid, acquisition
 * timestamp, and a release token.
 *
 * Staleness: a lock is reclaimable when its owner process is gone, when a
 * stamped lock is older than `staleMs` (wedged-owner recovery), or when an
 * unstamped lock (owner crashed between `mkdir` and stamping) is older than
 * `acquireStaleMs`.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import { isEnoent } from "./fs-error";
import * as logger from "./logger";

export interface FileLockOptions {
	/** Age after which a stamped lock is reclaimable even if its owner is alive. */
	staleMs?: number;
	/** Age after which an unstamped lock (crash mid-acquisition) is reclaimable; defaults to `staleMs`. */
	acquireStaleMs?: number;
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<Omit<FileLockOptions, "acquireStaleMs">> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

interface LockInfo {
	pid: number;
	timestamp: number;
	token: string;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function writeLockInfo(lockPath: string, token: string): Promise<void> {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now(), token };
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		return JSON.parse(content) as LockInfo;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the pid exists but belongs to another user — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Identity of a lock artifact judged stale, pinning exactly what a reaper is
 * allowed to remove: the stamped release token (or null while unstamped) and
 * the lock directory's mtime. A re-acquired lock never matches, so a slow
 * reaper cannot destroy a fresh owner's lock.
 */
interface StaleLockIdentity {
	token: string | null;
	mtimeMs: number;
}

async function getStaleLockIdentity(
	lockPath: string,
	staleMs: number,
	acquireStaleMs: number,
): Promise<StaleLockIdentity | null> {
	let mtimeMs: number;
	try {
		mtimeMs = (await fs.stat(lockPath)).mtimeMs;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	const info = await readLockInfo(lockPath);
	if (info) {
		if (!isProcessAlive(info.pid)) return { token: info.token, mtimeMs };
		if (Date.now() - info.timestamp > staleMs) return { token: info.token, mtimeMs };
		return null;
	}

	// No info file. Either the lock holder is between mkdir and writeLockInfo
	// (fresh dir, do not reap) or the dir was already removed (also do not
	// reap — there is nothing to clean up).
	return Date.now() - mtimeMs > acquireStaleMs ? { token: null, mtimeMs } : null;
}

/**
 * Remove a stale lock without ever destroying a re-acquired one. The lock
 * directory is atomically renamed into a unique graveyard path — only one
 * concurrent reaper can win that claim — and deleted only if the claimed
 * artifact still matches the identity that was judged stale; a mismatch
 * (the lock was reaped and re-acquired in between) is renamed back.
 */
async function reapStaleLock(lockPath: string, expected: StaleLockIdentity): Promise<void> {
	const grave = `${lockPath}.reap-${randomUUID()}`;
	try {
		await fs.rename(lockPath, grave);
	} catch (err) {
		// Another reaper already claimed it (or the owner released) — done.
		if (isEnoent(err)) return;
		throw err;
	}
	let matches = false;
	try {
		const stat = await fs.stat(grave);
		const info = await readLockInfo(grave);
		matches = (info?.token ?? null) === expected.token && stat.mtimeMs === expected.mtimeMs;
	} catch {
		// Unreadable graveyard: treat as non-matching and restore below.
	}
	if (matches) {
		await fs.rm(grave, { recursive: true, force: true });
		return;
	}
	// We claimed a lock that was re-acquired between judgment and rename —
	// put it back. If a newer lock already took the path, drop the graveyard;
	// the displaced owner's token-checked release degrades to a no-op.
	try {
		await fs.rename(grave, lockPath);
	} catch {
		logger.debug("file-lock: dropping displaced lock after failed restore", { lockPath, grave });
		await fs.rm(grave, { recursive: true, force: true }).catch(() => {});
	}
}

async function tryAcquireLock(lockPath: string): Promise<string | null> {
	try {
		await fs.mkdir(lockPath);
		const token = randomUUID();
		await writeLockInfo(lockPath, token);
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return null;
		}
		throw error;
	}
}

async function releaseLock(lockPath: string, expectedToken: string): Promise<void> {
	try {
		const info = await readLockInfo(lockPath);
		if (!info || info.token !== expectedToken) {
			// We are not the owner. The lock either expired and was reaped
			// or another process has reclaimed it. Do nothing — releasing
			// here would wipe the rightful owner's lock.
			logger.debug("file-lock: skipping release for non-owned lock", {
				lockPath,
				expectedToken,
				actualToken: info?.token,
			});
			return;
		}
		await fs.rm(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release.
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const acquireStaleMs = options.acquireStaleMs ?? opts.staleMs;
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const token = await tryAcquireLock(lockPath);
		if (token !== null) {
			return () => releaseLock(lockPath, token);
		}

		const stale = await getStaleLockIdentity(lockPath, opts.staleMs, acquireStaleMs);
		if (stale) {
			await reapStaleLock(lockPath, stale);
			continue;
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding the exclusive `${filePath}.lock` advisory lock. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * Test-only handles for the internal lock primitives. These are NOT part of
 * the public API — they exist so the contract tests can validate token-keyed
 * release semantics and the mkdir-race window without re-implementing them.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	getStaleLockIdentity,
	reapStaleLock,
	getLockPath,
};
