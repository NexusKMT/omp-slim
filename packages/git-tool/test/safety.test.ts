import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSafety } from "../src/safety/guards";
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

describe("git-tool safety", () => {
	it("blocks force push to protected branch", async () => {
		writeFile(join(repoDir, "init.txt"), "init");
		runGit(["add", "."], repoDir);
		runGit(["commit", "-m", "init"], repoDir);
		runGit(["branch", "-M", "main"], repoDir);
		const result = await checkSafety("push", { force: true });
		expect(result.blocked).toBe(true);
	});

	it("warns on discard changes", async () => {
		const result = await checkSafety("restore", { worktree: true });
		expect(result.blocked).toBe(false);
		expect(result.confirm).toBe(false);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("warns on branch delete", async () => {
		const result = await checkSafety("branch", { action: "delete" });
		expect(result.blocked).toBe(false);
		expect(result.confirm).toBe(false);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("blocks amend when HEAD is pushed", async () => {
		runGit(["branch", "-M", "main"], repoDir);
		writeFile(join(repoDir, "file.txt"), "hello");
		runGit(["add", "file.txt"], repoDir);
		runGit(["commit", "-m", "initial"], repoDir);

		const remoteDir = mkdtempSync(join(tmpdir(), "git-tool-remote-"));
		runGit(["init", "--bare"], remoteDir);
		runGit(["remote", "add", "origin", remoteDir], repoDir);
		runGit(["push", "-u", "origin", "main"], repoDir);

		const result = await checkSafety("commit", { amend: true });
		expect(result.blocked).toBe(true);

		cleanupRepo(remoteDir);
	});

	it("blocks rebase when HEAD is pushed", async () => {
		runGit(["branch", "-M", "main"], repoDir);
		writeFile(join(repoDir, "file.txt"), "hello");
		runGit(["add", "file.txt"], repoDir);
		runGit(["commit", "-m", "initial"], repoDir);

		const remoteDir = mkdtempSync(join(tmpdir(), "git-tool-remote-"));
		runGit(["init", "--bare"], remoteDir);
		runGit(["remote", "add", "origin", remoteDir], repoDir);
		runGit(["push", "-u", "origin", "main"], repoDir);

		const result = await checkSafety("rebase", {});
		expect(result.blocked).toBe(true);

		cleanupRepo(remoteDir);
	});
});
