import { expect, test } from "bun:test";
import { openSqliteDatabase } from "../src/sqlite";
import { TempDir } from "../src/temp";

test("failed asynchronous initialization releases and rolls back its write transaction", async () => {
	await using dir = await TempDir.create("@omp-sqlite-init-");
	const dbPath = dir.join("store.db");
	await expect(
		openSqliteDatabase(dbPath, async db => {
			db.run("CREATE TABLE entries (value TEXT)");
			db.run("BEGIN IMMEDIATE");
			db.run("INSERT INTO entries VALUES ('uncommitted')");
			await Promise.resolve();
			db.run("INSERT INTO missing_table VALUES (1)");
		}),
	).rejects.toThrow(dbPath);

	const rows = await openSqliteDatabase(dbPath, db => {
		try {
			db.run("INSERT INTO entries VALUES ('reopened')");
			return db.query<{ value: string }, []>("SELECT value FROM entries").all();
		} finally {
			db.close();
		}
	});
	expect(rows).toEqual([{ value: "reopened" }]);
});
