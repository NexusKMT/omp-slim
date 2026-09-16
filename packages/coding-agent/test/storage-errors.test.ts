import { Database, SQLiteError } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { isSqliteCorruptionError, TempDir } from "@oh-my-pi/pi-utils";

const stores = [
	{
		name: "agent",
		open: async (dbPath: string) => {
			await AgentStorage.open(dbPath);
			AgentStorage.close();
		},
	},
	{
		name: "history",
		open: (dbPath: string) => {
			HistoryStorage.open(dbPath);
			HistoryStorage.close();
		},
	},
	{
		name: "auth",
		open: async (dbPath: string) => {
			const storage = await SqliteAuthCredentialStore.open(dbPath);
			storage.close();
		},
	},
];

for (const store of stores) {
	test(`${store.name} startup identifies the corrupt database without replacing its contents`, async () => {
		await using tempDir = await TempDir.create("@omp-storage-errors-");
		const dbPath = tempDir.join(`${store.name}.db`);
		const db = new Database(dbPath);
		db.run("CREATE TABLE preserved (value TEXT)");
		db.close();
		const damaged = await Bun.file(dbPath).bytes();
		// Keep the SQLite header valid: opening succeeds, but reading the schema fails.
		damaged[100] = 0xff;
		await Bun.write(dbPath, damaged);

		let failure: unknown;
		try {
			await store.open(dbPath);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SQLiteError);
		expect(isSqliteCorruptionError(failure)).toBe(true);
		if (!(failure instanceof Error)) throw new Error("Expected database initialization to fail");
		expect(failure.message).toContain(dbPath);
		expect(failure.message).toContain("malformed");
		expect(await Bun.file(dbPath).bytes()).toEqual(damaged);
	});
}
