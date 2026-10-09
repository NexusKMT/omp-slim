import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runAnonymizeCommand } from "../src/cli/anonymize-cli";

const SESSION = `${JSON.stringify({ type: "session", version: 3, id: "01a0c9ac", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" })}
${JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: "keep me", timestamp: 1 } })}
`;

describe("omp anonymize output", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-anonymize-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("refuses an --out directory that would overwrite or bundle the source session", async () => {
		const source = path.join(tempDir.path(), "session.jsonl");
		await Bun.write(source, SESSION);

		await expect(runAnonymizeCommand({ session: source, out: tempDir.path() })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(source).text()).toBe(SESSION);
	});

	it("refuses an --out directory inside the raw subagent directory, even before it exists", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(source, SESSION);
		await Bun.write(path.join(tempDir.path(), "main", "Scout.jsonl"), SESSION);

		await expect(runAnonymizeCommand({ session: source, out: path.join(tempDir.path(), "main") })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(path.join(tempDir.path(), "main", "session.jsonl")).exists()).toBe(false);
	});

	it("rejects a file without a valid session header instead of writing an empty bundle", async () => {
		const source = path.join(tempDir.path(), "notes.jsonl");
		const out = path.join(tempDir.path(), "out");
		await Bun.write(source, `${JSON.stringify({ hello: "world" })}\n`);

		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not a valid session file");
		expect(await Bun.file(path.join(out, "session.jsonl")).exists()).toBe(false);
	});
});
