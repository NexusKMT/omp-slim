import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

async function corruptDatabase(dbPath: string): Promise<Uint8Array<ArrayBuffer>> {
	const db = new Database(dbPath);
	db.run("CREATE TABLE IF NOT EXISTS preserved (value TEXT)");
	// An unfinalized prepared statement would leave the closed connection a zombie
	// still holding the files, which Windows then refuses to quarantine.
	db.run("INSERT INTO preserved (value) VALUES (?)", ["salvage this data"]);
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();

	const damaged = await Bun.file(dbPath).bytes();
	// Keep the SQLite header valid while corrupting the first b-tree page type.
	// Opening the file succeeds, but reading its schema raises SQLITE_CORRUPT.
	damaged[100] = 0xff;
	await Bun.write(dbPath, damaged);
	return damaged;
}

async function expectQuarantinedDamage(dbPath: string, damaged: Uint8Array<ArrayBuffer>): Promise<void> {
	const prefix = `${path.basename(dbPath)}.corrupt-`;
	const backupNames = (await fs.readdir(path.dirname(dbPath))).filter(
		name => name.startsWith(prefix) && !name.endsWith("-wal") && !name.endsWith("-shm") && !name.endsWith("-journal"),
	);
	expect(backupNames).toHaveLength(1);
	expect(await Bun.file(path.join(path.dirname(dbPath), backupNames[0]!)).bytes()).toEqual(damaged);
}

test("agent startup quarantines corruption and persists new usage", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("agent.db");

	AgentStorage.close();
	const original = await AgentStorage.open(dbPath);
	original.recordModelUsage("test/damaged");
	AgentStorage.close();
	const damaged = await corruptDatabase(dbPath);

	try {
		const storage = await AgentStorage.open(dbPath);
		expect(storage.getModelUsageOrder()).toEqual([]);
		storage.recordModelUsage("test/recovered");
	} finally {
		AgentStorage.close();
	}

	const reopened = await AgentStorage.open(dbPath);
	try {
		expect(reopened.getModelUsageOrder()).toEqual(["test/recovered"]);
	} finally {
		AgentStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("history startup quarantines corruption and persists searchable prompts", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("history.db");

	HistoryStorage.close();
	const original = HistoryStorage.open(dbPath);
	await original.add("damaged history prompt", "/damaged", "damaged-session");
	HistoryStorage.close();
	const damaged = await corruptDatabase(dbPath);

	try {
		const storage = HistoryStorage.open(dbPath);
		expect(storage.getRecent(10)).toEqual([]);
		await storage.add("recovered searchable prompt", "/recovered", "recovered-session");
	} finally {
		HistoryStorage.close();
	}

	const reopened = HistoryStorage.open(dbPath);
	try {
		expect(reopened.search("searchable", 10)).toMatchObject([
			{
				prompt: "recovered searchable prompt",
				cwd: "/recovered",
				sessionId: "recovered-session",
			},
		]);
	} finally {
		HistoryStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});
