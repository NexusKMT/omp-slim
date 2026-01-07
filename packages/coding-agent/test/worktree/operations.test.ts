import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WORKTREE_BASE } from "../../src/lib/worktree/constants";
import { WorktreeError } from "../../src/lib/worktree/errors";
import { git } from "../../src/lib/worktree/git";
import { create, find, list, remove } from "../../src/lib/worktree/operations";

let repoPath: string;
let originalCwd: string;

async function createTestRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "wt-test-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test User"], dir);
	await Bun.write(path.join(dir, "README.md"), "init");
	await git(["add", "README.md"], dir);
	await git(["commit", "-m", "init"], dir);
	return dir;
}

async function cleanupRepo(repoRoot: string): Promise<void> {
	const repoName = path.basename(repoRoot);
	await rm(path.join(WORKTREE_BASE, repoName), { recursive: true, force: true });
	await rm(repoRoot, { recursive: true, force: true });
}

describe("worktree operations", () => {
	beforeEach(async () => {
		originalCwd = process.cwd();
		repoPath = await createTestRepo();
		process.chdir(repoPath);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await cleanupRepo(repoPath);
	});

	test("create worktree with new branch", async () => {
		const wt = await create("feature-test");
		expect(wt.branch).toBe("feature-test");
		expect(existsSync(wt.path)).toBe(true);
	});

	test("create worktree with existing branch", async () => {
		await git(["branch", "existing-branch"], repoPath);
		const wt = await create("existing-branch");
		expect(wt.branch).toBe("existing-branch");
	});

	test("list worktrees", async () => {
		await create("feature-1");
		await create("feature-2");
		const worktrees = await list();
		expect(worktrees.length).toBe(3);
	});

	test("find worktree by branch", async () => {
		await create("my-feature");
		const wt = await find("my-feature");
		expect(wt.branch).toBe("my-feature");
	});

	test("find worktree by partial match", async () => {
		await create("feature-authentication");
		const wt = await find("auth");
		expect(wt.branch).toBe("feature-authentication");
	});

	test("remove worktree", async () => {
		const wt = await create("to-remove");
		await remove("to-remove");
		expect(existsSync(wt.path)).toBe(false);
	});

	test("cannot remove main worktree", async () => {
		await expect(remove("main")).rejects.toThrow(WorktreeError);
	});
});
