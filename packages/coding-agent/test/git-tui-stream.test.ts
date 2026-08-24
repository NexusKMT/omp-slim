import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiffSide, DiffStream } from "@oh-my-pi/pi-natives";
import { $ } from "bun";
import { buildDiffDocument } from "../src/cli/git-tui/diff-pane";
import { GitModel } from "../src/cli/git-tui/state";

async function streamedDocument(oldText: string, newText: string) {
	const stream = new DiffStream();
	stream.push(DiffSide.Old, oldText.slice(0, Math.floor(oldText.length / 2)));
	stream.push(DiffSide.Old, oldText.slice(Math.floor(oldText.length / 2)));
	stream.push(DiffSide.New, newText.slice(0, Math.floor(newText.length / 2)));
	stream.push(DiffSide.New, newText.slice(Math.floor(newText.length / 2)));
	stream.finishSide(DiffSide.Old);
	stream.finishSide(DiffSide.New);
	const streamResult = await stream.finish(3);
	return buildDiffDocument(stream.text(DiffSide.Old), stream.text(DiffSide.New), "fixture.ts", { streamResult });
}

describe("git TUI streamed document", () => {
	test("uses an empty base side for a staged added file", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tui-stream-"));
		try {
			await $`git init --initial-branch=main`.cwd(repo).quiet();
			await $`git config user.name "Test User"`.cwd(repo).quiet();
			await $`git config user.email "test@example.com"`.cwd(repo).quiet();
			await Bun.write(path.join(repo, "seed.txt"), "seed\n");
			await $`git add seed.txt`.cwd(repo).quiet();
			await $`git commit -m base`.cwd(repo).quiet();
			await Bun.write(path.join(repo, "added.ts"), "export const added = true;\n");
			await $`git add added.ts`.cwd(repo).quiet();

			const model = new GitModel(repo);
			await model.refresh();
			const file = model.staged.find(candidate => candidate.path === "added.ts");
			if (!file) throw new Error("staged added file was not discovered");
			let updates = 0;
			const contents = await model.streamContents(file, () => {
				updates++;
			});
			expect(contents.oldText).toBe("");
			expect(contents.newText).toBe("export const added = true;\n");
			expect(contents.streamResult).not.toBeNull();
			expect(updates).toBeGreaterThan(0);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	test.each([
		["replacement", "a\nb\nc\n", "a\nx\nc\n"],
		["insert and delete", "a\nb\nc\nd\n", "a\nnew\nb\nd\n"],
		["EOF newline transition", "a\nb", "a\nb\n"],
	])("matches the exact synchronous builder for %s", async (_name, oldText, newText) => {
		const streamed = await streamedDocument(oldText, newText);
		const synchronous = buildDiffDocument(oldText, newText, "fixture.ts");
		expect(streamed).toEqual(synchronous);
	});
});
