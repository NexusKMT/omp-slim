import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiffSide, DiffStream } from "@oh-my-pi/pi-natives";
import { $ } from "bun";
import { buildDiffDocument, buildLineSelectionPatch, type DiffBuildOptions } from "../src/cli/git-tui/diff-pane";
import { GitModel } from "../src/cli/git-tui/state";

async function streamedDocument(oldText: string, newText: string, options: DiffBuildOptions = {}) {
	const stream = new DiffStream();
	stream.push(DiffSide.Old, oldText.slice(0, Math.floor(oldText.length / 2)));
	stream.push(DiffSide.Old, oldText.slice(Math.floor(oldText.length / 2)));
	stream.push(DiffSide.New, newText.slice(0, Math.floor(newText.length / 2)));
	stream.push(DiffSide.New, newText.slice(Math.floor(newText.length / 2)));
	stream.finishSide(DiffSide.Old);
	stream.finishSide(DiffSide.New);
	const streamResult = await stream.finish(3);
	return buildDiffDocument(stream.text(DiffSide.Old), stream.text(DiffSide.New), "fixture.ts", {
		...options,
		streamResult,
	});
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
describe("formatting-ignore whitespace mode", () => {
	const FMT: DiffBuildOptions = { whitespace: "formatting" };
	const SPLIT_OLD = "const x = foo(a, b);\nkeep\n";
	const SPLIT_NEW = "const x = foo(\n\ta,\n\tb\n);\nkeep\n";

	test("demotes line splits that only move whitespace", () => {
		const doc = buildDiffDocument(SPLIT_OLD, SPLIT_NEW, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
		expect(doc.rows.every(row => row.kind === "context")).toBe(true);
		// One-sided demoted rows keep their new-file line numbers for the gutter.
		expect(doc.rows.map(row => row.newNum)).toEqual([1, 2, 3, 4, 5]);
	});

	test("keeps blocks that change more than whitespace", () => {
		const doc = buildDiffDocument(SPLIT_OLD, "const x = foo(\n\ta,\n\tc\n);\nkeep\n", "fixture.ts", FMT);
		expect(doc.deletions).toBe(1);
		expect(doc.additions).toBe(4);
		expect(doc.hunks.length).toBeGreaterThan(0);
	});

	test("demotes import-only additions in ts", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { a } from "./a";\nimport { b } from "./b";\nconst v = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("demotes rust use reordering across separate blocks", () => {
		const oldText = "use b::B;\nuse a::A;\nfn main() {}\n";
		const newText = "use a::A;\nuse b::B;\nfn main() {}\n";
		const doc = buildDiffDocument(oldText, newText, "lib.rs", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("import demotion is language-gated", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { a } from "./a";\nimport { b } from "./b";\nconst v = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.py", FMT);
		expect(doc.additions).toBe(1);
	});

	test("keeps import lines mixed with a real change in one block", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { b } from "./b";\nconst v = 2;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.deletions).toBe(2);
		expect(doc.additions).toBe(2);
	});
	test("demotes an import add fused with a whitespace reflow in one block", () => {
		const oldText = 'import { a } from "./a";\nconst x = foo(a, b);\nexport const k = 1;\n';
		const newText =
			'import { a } from "./a";\nimport { b } from "./b";\nconst x = foo(\n\ta,\n\tb\n);\nexport const k = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("keeps hunk patches, unlike whitespace mode", () => {
		const oldText = "value = 1\n";
		const newText = "value = 2\n";
		expect(buildDiffDocument(oldText, newText, "fixture.ts", { whitespace: "whitespace" }).canPatch).toBe(false);
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.canPatch).toBe(true);
		expect(doc.hunks[0]?.patch).toContain("+value = 2");
	});

	test("selection patches reconstruct the base across demoted one-sided rows", () => {
		const oldText = "foo(a, b)\nmid\nvalue = 1\n";
		const newText = "foo(\na,\nb\n)\nmid\nvalue = 2\n";
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		const index = doc.rows.findIndex(row => row.kind === "change");
		expect(index).toBeGreaterThanOrEqual(0);
		const patch = buildLineSelectionPatch(doc, index, index, "apply");
		expect(patch).not.toBeNull();
		// Demoted context must mirror the old side, not leak empty lines.
		expect(patch).toContain(" foo(a, b)");
		expect(patch).toContain("+value = 2");
	});

	test("streamed formatting document matches the synchronous builder", async () => {
		const streamed = await streamedDocument(SPLIT_OLD, SPLIT_NEW, FMT);
		expect(streamed).toEqual(buildDiffDocument(SPLIT_OLD, SPLIT_NEW, "fixture.ts", FMT));
	});
});
