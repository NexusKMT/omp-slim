import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitTool } from "../src/git-tool";
import type { StatusResult, ToolResult } from "../src/types";
import { cleanupRepo, createTestRepo, runGit, writeFile } from "./helpers";

let repoDir: string;
let previousCwd: string;

beforeEach(() => {
	previousCwd = process.cwd();
	repoDir = createTestRepo();
	process.chdir(repoDir);
});

afterEach(() => {
	process.chdir(previousCwd);
	cleanupRepo(repoDir);
});

describe("git-tool cache", () => {
	it("invalidates status cache on write operations", async () => {
		writeFile(join(repoDir, "file.txt"), "hello");
		runGit(["add", "file.txt"], repoDir);
		runGit(["commit", "-m", "initial"], repoDir);

		writeFile(join(repoDir, "file.txt"), "hello world");

		const status1 = (await gitTool({ operation: "status" })) as ToolResult<StatusResult>;
		expect(status1.data.modified.map((file) => file.path)).toContain("file.txt");

		await gitTool({ operation: "add", paths: ["file.txt"] });

		const status2 = (await gitTool({ operation: "status" })) as ToolResult<StatusResult>;
		expect(status2.data.staged.map((file) => file.path)).toContain("file.txt");
		expect(status2.data.modified.map((file) => file.path)).not.toContain("file.txt");
	});
});
