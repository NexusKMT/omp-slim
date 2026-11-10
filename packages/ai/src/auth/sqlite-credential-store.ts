import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthCredentialStore } from "./store";
import type { AuthCredential, StoredAuthCredential } from "./types";
export { isSqliteBusyError, isSqliteCorruptionError } from "@oh-my-pi/pi-utils";
interface AuthRow {
	id: number;
	provider: string;
	data: string;
	disabled_cause: string | null;
}
/** Uses the existing credential table while ignoring retired credential types. */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	#dataVersion: number;
	constructor(db: Database) {
		this.#db = db;
		db.run("PRAGMA busy_timeout = 5000");
		db.run(
			`CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
		);
		this.#dataVersion = this.#version();
	}
	static async open(dbPath: string): Promise<SqliteAuthCredentialStore> {
		if (dbPath !== ":memory:") await fs.mkdir(path.dirname(dbPath), { recursive: true });
		return new SqliteAuthCredentialStore(new Database(dbPath, { create: true }));
	}
	#version(): number {
		return this.#db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
	}
	pollExternalChanges(): boolean {
		const next = this.#version();
		const changed = next !== this.#dataVersion;
		this.#dataVersion = next;
		return changed;
	}
	acknowledgeLocalChanges(): void {
		this.#dataVersion = this.#version();
	}
	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows =
			provider === undefined
				? this.#db
						.query<AuthRow, []>(
							"SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE credential_type = 'api_key' AND disabled_cause IS NULL ORDER BY id",
						)
						.all()
				: this.#db
						.query<AuthRow, [string]>(
							"SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL ORDER BY id",
						)
						.all(provider);
		const out: StoredAuthCredential[] = [];
		for (const row of rows) {
			try {
				const credential = JSON.parse(row.data) as AuthCredential;
				if (credential.type === "api_key" && typeof credential.key === "string")
					out.push({ id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause });
			} catch {
				/* A malformed row cannot supply a credential. */
			}
		}
		return out;
	}
	#insert(provider: string, credential: AuthCredential): void {
		if (credential.type !== "api_key" || typeof credential.key !== "string")
			throw new Error("Only API-key credentials are supported");
		this.#db
			.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?)")
			.run(provider, JSON.stringify(credential));
	}
	async replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
		this.#db.transaction(() => {
			this.#db
				.query(
					"UPDATE auth_credentials SET disabled_cause = 'replaced', updated_at = unixepoch() WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL",
				)
				.run(provider);
			for (const credential of credentials) this.#insert(provider, credential);
		})();
		return this.listAuthCredentials(provider);
	}
	async upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		const existing = this.listAuthCredentials(provider).find(row => row.credential.key === credential.key);
		if (existing)
			this.#db
				.query("UPDATE auth_credentials SET data = ?, updated_at = unixepoch() WHERE id = ?")
				.run(JSON.stringify(credential), existing.id);
		else this.#insert(provider, credential);
		return this.listAuthCredentials(provider);
	}
	async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
		this.#db
			.query(
				"UPDATE auth_credentials SET disabled_cause = ?, updated_at = unixepoch() WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL",
			)
			.run(disabledCause, provider);
	}
	async deleteAuthCredential(id: number, disabledCause: string): Promise<boolean> {
		return (
			this.#db
				.query(
					"UPDATE auth_credentials SET disabled_cause = ?, updated_at = unixepoch() WHERE id = ? AND credential_type = 'api_key' AND disabled_cause IS NULL",
				)
				.run(disabledCause, id).changes > 0
		);
	}
	close(): void {
		this.#db.close();
	}
}
