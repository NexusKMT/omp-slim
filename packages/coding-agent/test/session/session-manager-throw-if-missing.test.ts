import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("SessionManager.open with throwIfMissing", () => {
	it("rejects a missing file without creating it", async () => {
		const root = makeTempDir("@pi-open-throw-missing-");
		const missing = path.join(root, "missing.jsonl");

		await expect(SessionManager.open(missing, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/ENOENT/,
		);
		// Fail closed means no phantom session is materialized at the requested path.
		expect(fs.existsSync(missing)).toBe(false);
	});

	it("still mints at a missing path when the flag is omitted, keeping --session working", async () => {
		const root = makeTempDir("@pi-open-mint-default-");
		const fresh = path.join(root, "fresh.jsonl");

		const manager = await SessionManager.open(fresh, undefined, undefined, { initialCwd: root });
		expect(manager.getSessionFile()).toBe(path.resolve(fresh));
		expect(fs.existsSync(fresh)).toBe(true);
		await manager.close();
	});

	it("rejects an existing but empty file instead of rewriting it", async () => {
		const root = makeTempDir("@pi-open-throw-empty-");
		const empty = path.join(root, "empty.jsonl");
		fs.writeFileSync(empty, "");

		await expect(SessionManager.open(empty, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/holds no entries/,
		);
		expect(fs.readFileSync(empty, "utf8")).toBe("");
	});
});
