import { describe, expect, it } from "vitest";
import { parseBlame } from "../src/parsers/blame-parser";
import { parseDiff } from "../src/parsers/diff-parser";
import { parseLog } from "../src/parsers/log-parser";
import { parseStatus } from "../src/parsers/status-parser";

const RS = "\x1e";
const FS = "\x00";

describe("git-tool parsers", () => {
	it("parses status porcelain v2", () => {
		const output = [
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +1 -2",
			"1 M. N... 100644 100644 100644 file1.txt",
			"1 .M N... 100644 100644 100644 file2.txt",
			"u UU N... 100644 100644 100644 conflict.txt",
			"? untracked.txt",
			"! ignored.log",
		].join("\n");

		const result = parseStatus(output, true);
		expect(result.branch).toBe("main");
		expect(result.upstream).toBe("origin/main");
		expect(result.ahead).toBe(1);
		expect(result.behind).toBe(2);
		expect(result.staged.map((item) => item.path)).toContain("file1.txt");
		expect(result.modified.map((item) => item.path)).toContain("file2.txt");
		expect(result.conflicts).toContain("conflict.txt");
		expect(result.untracked).toContain("untracked.txt");
		expect(result.ignored).toContain("ignored.log");
	});

	it("parses unified diff", () => {
		const diff = [
			"diff --git a/file.txt b/file.txt",
			"index 123..456 100644",
			"--- a/file.txt",
			"+++ b/file.txt",
			"@@ -1,2 +1,3 @@",
			" line1",
			"-line2",
			"+line2 changed",
			"+line3",
		].join("\n");

		const result = parseDiff(diff);
		expect(result.files).toHaveLength(1);
		const file = result.files[0];
		expect(file.path).toBe("file.txt");
		expect(file.additions).toBe(2);
		expect(file.deletions).toBe(1);
		expect(file.hunks?.length).toBe(1);
	});

	it("parses log format", () => {
		const record = [
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"aaaaaaa",
			"Alice",
			"alice@example.com",
			"2024-01-01T00:00:00Z",
			"Bob",
			"bob@example.com",
			"2024-01-01T01:00:00Z",
			"",
			"Commit subject",
			"Commit body",
		].join(FS);
		const output = `${record}${RS}`;
		const commits = parseLog(output);
		expect(commits).toHaveLength(1);
		expect(commits[0].subject).toBe("Commit subject");
		expect(commits[0].message).toContain("Commit body");
	});

	it("parses blame porcelain", () => {
		const output = [
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1",
			"author Alice",
			"author-time 1700000000",
			"filename file.txt",
			"\tline one",
		].join("\n");
		const lines = parseBlame(output);
		expect(lines).toHaveLength(1);
		expect(lines[0].author).toBe("Alice");
		expect(lines[0].content).toBe("line one");
	});
});
