import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("loadSessionFile path errors", () => {
	it("rejects a session path with a regular-file component", async () => {
		await using dir = await TempDir.create("omp-session-enotdir-");
		const file = path.join(dir.path(), "plain-file.txt");
		await Bun.write(file, "not a directory");
		const sessionPath = path.join(file, "sub", "session.jsonl");
		await expect(loadSessionFile(sessionPath)).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(loadSessionFile(sessionPath, undefined, { throwIfMissing: true })).rejects.toMatchObject({
			code: "ENOTDIR",
		});
	});
});
