import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findJjRoot,
	formatJjBranch,
	parseJjStatus,
	queryJjBranch,
	queryJjStatus,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/jj-info";

describe("formatJjBranch", () => {
	test("returns the bookmark on @ over the change-id", () => {
		expect(formatJjBranch("kvisqosn|feature-x\n")).toBe("feature-x");
	});

	test("returns the nearest ancestor bookmark when @ has none", () => {
		expect(formatJjBranch("kvisqosn|\nqlnsqysu|polo-integration\n")).toBe("polo-integration");
	});

	test("prefers @'s own bookmark over an ancestor bookmark", () => {
		expect(formatJjBranch("kvisqosn|on-branch\nqlnsqysu|ancestor\n")).toBe("on-branch");
	});

	test("collapses multiple bookmarks at the nearest commit", () => {
		expect(formatJjBranch("qlnsqysu|foo bar\n")).toBe("foo bar");
	});

	test("falls back to @'s change-id when no bookmark in ancestry", () => {
		expect(formatJjBranch("kvisqosn|\n")).toBe("kvisqosn");
	});

	test("returns null for empty or whitespace-only output", () => {
		expect(formatJjBranch("")).toBeNull();
		expect(formatJjBranch("  \n\t ")).toBeNull();
	});
});

describe("findJjRoot", () => {
	test("walks up to the nearest ancestor holding .jj", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jj-root-"));
		try {
			await fs.promises.mkdir(path.join(root, ".jj"));
			const nested = path.join(root, "packages", "coding-agent");
			await fs.promises.mkdir(nested, { recursive: true });
			expect(findJjRoot(nested)).toBe(root);
			expect(findJjRoot(root)).toBe(root);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("returns null when no .jj ancestor exists", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "no-jj-"));
		try {
			expect(findJjRoot(dir)).toBeNull();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("queryJjBranch", () => {
	test("returns the nearest bookmark from runner stdout", async () => {
		const desc = await queryJjBranch("/repo", async () => ({
			exitCode: 0,
			stdout: "kvisqosn|\nqlnsqysu|polo-integration\n",
		}));
		expect(desc).toBe("polo-integration");
	});

	test("returns null on non-zero exit (not a jj repo)", async () => {
		const desc = await queryJjBranch("/repo", async () => ({ exitCode: 1, stdout: "" }));
		expect(desc).toBeNull();
	});

	test("returns null when the runner throws (jj binary absent)", async () => {
		const desc = await queryJjBranch("/repo", async () => {
			throw new Error("spawn jj ENOENT");
		});
		expect(desc).toBeNull();
	});

	test("treats empty successful output as null", async () => {
		const desc = await queryJjBranch("/repo", async () => ({ exitCode: 0, stdout: "\n" }));
		expect(desc).toBeNull();
	});
});

describe("parseJjStatus / queryJjStatus", () => {
	test("maps jj diff --summary types to the status shape (A -> untracked, else unstaged)", () => {
		expect(parseJjStatus("M a.ts\nA b.ts\nA c.ts\nD d.ts\nM e.ts\n")).toEqual({
			staged: 0,
			unstaged: 3,
			untracked: 2,
		});
	});

	test("a clean working copy is all zeros", () => {
		expect(parseJjStatus("")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
	});

	test("queryJjStatus parses runner stdout", async () => {
		expect(await queryJjStatus("/repo", async () => ({ exitCode: 0, stdout: "M x.ts\nA y.ts\n" }))).toEqual({
			staged: 0,
			unstaged: 1,
			untracked: 1,
		});
	});

	test("queryJjStatus returns null on non-zero exit (not a jj repo)", async () => {
		expect(await queryJjStatus("/repo", async () => ({ exitCode: 1, stdout: "" }))).toBeNull();
	});

	test("queryJjStatus returns null when the runner throws (jj binary absent)", async () => {
		expect(
			await queryJjStatus("/repo", async () => {
				throw new Error("spawn jj ENOENT");
			}),
		).toBeNull();
	});
});
