/** Shared SQLite opening, error attribution, and result-code classification for persistent stores. */
import { Database } from "bun:sqlite";
import { getDbBusyTimeoutMs } from "./env";

/**
 * Opens and initializes a store, retrying BUSY failures up to four total attempts.
 * Installs the busy handler before initialization and closes failed connections.
 * The initializer may run again on a fresh connection; on success it owns the handle.
 * Final failures retain their SQLite codes and include the database path.
 */
export async function openSqliteDatabase<T>(dbPath: string, initialize: (db: Database) => T | Promise<T>): Promise<T> {
	const maxAttempts = 4;
	const baseDelayMs = 100;
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		try {
			db = new Database(dbPath);
			// WAL recovery can bypass the busy handler; both it and retries are needed (#2421).
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			return await initialize(db);
		} catch (error) {
			db?.close();
			if (!isSqliteBusyError(error) || attempt + 1 >= maxAttempts) {
				throw annotateSqliteError(error, dbPath);
			}
			await Bun.sleep(baseDelayMs * 2 ** attempt);
		}
	}
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	annotated.message = `Database ${JSON.stringify(dbPath)}: ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * SQLite's unrecoverable-corruption result codes — the `SQLITE_CORRUPT` family
 * (base plus extended variants like `SQLITE_CORRUPT_VTAB` / `SQLITE_CORRUPT_INDEX`)
 * and `SQLITE_NOTADB` (the file header is not a database). Unlike
 * {@link isSqliteBusyError}, these never clear by retrying: the store must be
 * repaired or replaced, so callers latch, quarantine, or recreate the file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
