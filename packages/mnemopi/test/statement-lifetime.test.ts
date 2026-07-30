import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const cleanup: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-statement-lifetime-"));
	cleanup.push(dir);
	return dir;
}

afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("prepared statement lifetime", () => {
	// An unfinalized statement keeps the SQLite connection open, so close() is a
	// no-op and the file stays locked. close(true) is the direct assertion:
	// closeQuietly() swallows the same error, which is why the leak went unseen.
	it("leaves no statement holding the connection after the store paths run", () => {
		const dbPath = join(tempDir(), "mnemopi.db");
		const beam = new BeamMemory({ sessionId: "lifetime", dbPath });
		const id = beam.remember("statement lifetime check", { source: "test", importance: 0.5 });
		beam.get(id);
		beam.scratchpadWrite("pad entry");
		beam.scratchpadRead();
		beam.updateWorking(id, "statement lifetime check, edited");
		beam.getWorkingStats();
		beam.exportToDict();
		beam.forgetWorking(id);
		beam.scratchpadClear();

		expect(() => beam.db.close(true)).not.toThrow();
	});

	// SQLite removes the -wal/-shm sidecars when the last connection closes
	// cleanly, so their presence after close() means the connection outlived it.
	// On Windows that also makes the bank undeletable, which is the user-visible
	// half of the bug; on POSIX an open file can still be unlinked.
	it("releases the database file so a closed bank can be deleted", () => {
		const dbPath = join(tempDir(), "mnemopi.db");
		const beam = new BeamMemory({ sessionId: "lifetime", dbPath });
		const id = beam.remember("deletable after close", { source: "test" });
		beam.get(id);
		beam.forgetWorking(id);
		beam.close();

		expect(existsSync(`${dbPath}-wal`)).toBe(false);
		expect(existsSync(`${dbPath}-shm`)).toBe(false);
		expect(() => rmSync(dbPath)).not.toThrow();
		expect(existsSync(dbPath)).toBe(false);
	});

	it("leaves no statement holding the connection after an annotation import round-trip", () => {
		const dbPath = join(tempDir(), "mnemopi.db");
		const beam = new BeamMemory({ sessionId: "lifetime", dbPath });
		beam.remember("annotated row", { source: "test" });
		const exported = beam.exportToDict();
		beam.close();

		const db = openDatabase(dbPath);
		expect(() => db.close(true)).not.toThrow();
		expect(exported.working_memory).toBeDefined();
	});
});
