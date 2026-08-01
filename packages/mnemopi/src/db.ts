import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config";

let _osPageSize: number | undefined;

function osPageSize(): number {
	if (_osPageSize !== undefined) return _osPageSize;
	try {
		const proc = Bun.spawnSync(["getconf", "PAGE_SIZE"], { stdout: "pipe" });
		if (proc.exitCode === 0) {
			const size = Number.parseInt(proc.stdout.toString().trim(), 10);
			if (size >= 512 && size <= 65536 && (size & (size - 1)) === 0) {
				_osPageSize = size;
				return size;
			}
		}
	} catch { /* fall through */ }
	_osPageSize = 4096;
	return 4096;
}

export type DatabasePath = string | ":memory:";

export interface OpenDatabaseOptions {
	readonly create?: boolean;
	readonly readwrite?: boolean;
	readonly strict?: boolean;
	readonly loadExtension?: string | readonly string[];
	readonly pragmas?: boolean;
}

interface TxState {
	depth: number;
}

const TX_STATE = Symbol("mnemopi.txState");

type TxDatabase = Database & { [TX_STATE]?: TxState };
type ExtensionDatabase = Database & { loadExtension(path: string): void };

export function openDatabase(path: DatabasePath = dbPath(), options: OpenDatabaseOptions = {}): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, {
		create: options.create ?? true,
		readwrite: options.readwrite ?? true,
		strict: options.strict ?? true,
	});
	if (options.pragmas !== false) enablePragmas(db, path);
	if (options.loadExtension !== undefined) loadExtensions(db, options.loadExtension);
	return db;
}
export function enablePragmas(db: Database, path?: DatabasePath): void {
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	if (path !== ":memory:") {
		const pageSize = osPageSize();
		if (pageSize !== 4096) db.exec(`PRAGMA page_size=${pageSize}`);
		db.exec("PRAGMA journal_mode=WAL");
	}
}

export function loadExtensions(db: Database, extensions: string | readonly string[]): void {
	if (typeof extensions === "string") {
		if (extensions) (db as ExtensionDatabase).loadExtension(extensions);
		return;
	}
	for (const extension of extensions) {
		if (extension) (db as ExtensionDatabase).loadExtension(extension);
	}
}

export function transaction<T>(db: Database, fn: () => T): T {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export const deferredTransaction = transaction;

export async function transactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return await fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = await fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export function closeQuietly(db: Database | undefined | null): void {
	if (db === undefined || db === null) return;
	try {
		db.close();
	} catch {
		// Best-effort cleanup.
	}
}
