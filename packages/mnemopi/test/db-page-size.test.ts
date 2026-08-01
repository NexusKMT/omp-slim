import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, closeQuietly } from "../src/db";

function expectedOsPageSize(): number {
	try {
		const proc = Bun.spawnSync(["getconf", "PAGE_SIZE"], { stdout: "pipe" });
		if (proc.exitCode === 0) {
			const size = Number.parseInt(proc.stdout.toString().trim(), 10);
			if (size >= 512 && size <= 65536 && (size & (size - 1)) === 0) return size;
		}
	} catch { /* fall through */ }
	return 4096;
}

const roots: string[] = [];

afterEach(() => {
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("db page size", () => {
	it("creates a new database with page size matching the OS page size", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-page-size-"));
		roots.push(root);
		const path = join(root, "test.db");

		const db = openDatabase(path);
		try {
			const pageSize = db.query("PRAGMA page_size").get() as { page_size: number };
			expect(pageSize.page_size).toBe(expectedOsPageSize());
		} finally {
			closeQuietly(db);
		}
	});

	it("does not set page_size on in-memory databases", () => {
		const db = openDatabase(":memory:");
		try {
			const pageSize = db.query("PRAGMA page_size").get() as { page_size: number };
			// In-memory DBs keep the SQLite default (4096) since there is no
			// persistent file whose I/O would benefit from OS page alignment.
			expect(pageSize.page_size).toBe(4096);
		} finally {
			closeQuietly(db);
		}
	});
});
