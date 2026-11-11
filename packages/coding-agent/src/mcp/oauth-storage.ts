/** MCP authorization grants are persisted independently of model-provider API keys. */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { MCPStoredOAuthCredential } from "./oauth-flow";

interface CredentialRow {
	data: string;
}
interface LegacyCredentialRow extends CredentialRow {
	id: number;
	provider: string;
}

function parseCredential(data: string): MCPStoredOAuthCredential | undefined {
	try {
		const value: unknown = JSON.parse(data);
		if (typeof value !== "object" || value === null) return undefined;
		if (
			Reflect.get(value, "type") !== "oauth" ||
			typeof Reflect.get(value, "access") !== "string" ||
			typeof Reflect.get(value, "refresh") !== "string" ||
			typeof Reflect.get(value, "expires") !== "number"
		)
			return undefined;
		return value as MCPStoredOAuthCredential;
	} catch {
		return undefined;
	}
}

export class MCPOAuthStorage {
	readonly #db: Database;
	readonly #locks = new Map<string, Promise<unknown>>();
	constructor(db: Database) {
		this.#db = db;
		db.run("PRAGMA busy_timeout = 5000");
		db.run("CREATE TABLE IF NOT EXISTS mcp_oauth_credentials (credential_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.run("CREATE TABLE IF NOT EXISTS mcp_oauth_legacy_imports (id INTEGER PRIMARY KEY)");
		if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'").get()) {
			const legacy = db
				.query<LegacyCredentialRow, []>(`SELECT id, provider, data FROM auth_credentials
				WHERE credential_type = 'oauth' AND disabled_cause IS NULL
				AND (provider GLOB 'mcp_oauth:*' OR provider GLOB 'mcp_oauth_*')
				AND id NOT IN (SELECT id FROM mcp_oauth_legacy_imports) ORDER BY id`)
				.all();
			db.transaction(() => {
				for (const row of legacy) {
					const credential = parseCredential(row.data);
					if (credential && credential.refresh !== "__remote__") {
						db.query("INSERT OR IGNORE INTO mcp_oauth_credentials (credential_id, data) VALUES (?, ?)").run(
							row.provider,
							row.data,
						);
					}
					db.query("INSERT OR IGNORE INTO mcp_oauth_legacy_imports (id) VALUES (?)").run(row.id);
				}
			})();
		}
	}
	static async open(dbPath: string): Promise<MCPOAuthStorage> {
		if (dbPath !== ":memory:") await fs.mkdir(path.dirname(dbPath), { recursive: true });
		return new MCPOAuthStorage(new Database(dbPath, { create: true }));
	}
	get(credentialId: string): MCPStoredOAuthCredential | undefined {
		const row = this.#db
			.query<CredentialRow, [string]>("SELECT data FROM mcp_oauth_credentials WHERE credential_id = ?")
			.get(credentialId);
		return row ? parseCredential(row.data) : undefined;
	}
	async set(credentialId: string, credential: MCPStoredOAuthCredential): Promise<void> {
		this.#db
			.query(
				"INSERT INTO mcp_oauth_credentials (credential_id, data) VALUES (?, ?) ON CONFLICT(credential_id) DO UPDATE SET data = excluded.data",
			)
			.run(credentialId, JSON.stringify(credential));
	}
	async remove(credentialId: string): Promise<void> {
		this.#db.query("DELETE FROM mcp_oauth_credentials WHERE credential_id = ?").run(credentialId);
	}
	/** A late refresh must never overwrite a newer login or another process's rotated grant. */
	replaceIfUnchanged(
		credentialId: string,
		observed: MCPStoredOAuthCredential,
		next: MCPStoredOAuthCredential | undefined,
	): boolean {
		return next
			? this.#db
					.query("UPDATE mcp_oauth_credentials SET data = ? WHERE credential_id = ? AND data = ?")
					.run(JSON.stringify(next), credentialId, JSON.stringify(observed)).changes > 0
			: this.#db
					.query("DELETE FROM mcp_oauth_credentials WHERE credential_id = ? AND data = ?")
					.run(credentialId, JSON.stringify(observed)).changes > 0;
	}
	/** Existing OS-backed file locks release automatically if a refresher crashes. */
	async withRefreshLock<T>(credentialId: string, fn: () => Promise<T>): Promise<T> {
		if (this.#db.filename !== ":memory:") {
			return withFileLock(`${this.#db.filename}.mcp-oauth-${Bun.hash(credentialId).toString(16)}`, fn, {
				retries: 900,
				retryDelayMs: 100,
			});
		}
		const previous = this.#locks.get(credentialId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(fn);
		this.#locks.set(credentialId, current);
		try {
			return await current;
		} finally {
			if (this.#locks.get(credentialId) === current) this.#locks.delete(credentialId);
		}
	}
	close(): void {
		this.#db.close();
	}
}

/** One durable MCP store per active agent directory for the process lifetime. */
const stores = new Map<string, Promise<MCPOAuthStorage>>();
export function discoverMcpOAuthStorage(agentDir = getAgentDir()): Promise<MCPOAuthStorage> {
	const dbPath = getAgentDbPath(agentDir);
	let store = stores.get(dbPath);
	if (!store) {
		store = MCPOAuthStorage.open(dbPath).catch(error => {
			stores.delete(dbPath);
			throw error;
		});
		stores.set(dbPath, store);
	}
	return store;
}
