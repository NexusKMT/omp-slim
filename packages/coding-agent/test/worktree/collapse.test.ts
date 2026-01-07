import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collapse } from "../../src/lib/worktree/collapse";
import { WORKTREE_BASE } from "../../src/lib/worktree/constants";
import { getRepoRoot, git } from "../../src/lib/worktree/git";
import { create } from "../../src/lib/worktree/operations";

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

describe("collapse strategies", () => {
	beforeEach(async () => {
		originalCwd = process.cwd();
		repoPath = await createTestRepo();
		process.chdir(repoPath);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await cleanupRepo(repoPath);
	});

	test("simple strategy applies uncommitted changes", async () => {
		const src = await create("source");

		await Bun.write(path.join(src.path, "new-file.txt"), "content");

		await collapse("source", "main", { strategy: "simple" });

		const mainPath = await getRepoRoot();
		const content = await Bun.file(path.join(mainPath, "new-file.txt")).text();
		expect(content).toBe("content");
	});

	test("rebase strategy handles divergent history", async () => {
		const src = await create("source");

		// Make a commit on main to create divergent history
		const mainPath = await getRepoRoot();
		await Bun.write(path.join(mainPath, "main-change.txt"), "main");
		await git(["add", "main-change.txt"], mainPath);
		await git(["commit", "-m", "main change"], mainPath);

		// Add uncommitted changes on source (collapseRebase stages and commits these)
		await Bun.write(path.join(src.path, "feature.txt"), "feature");

		await collapse("source", "main", { strategy: "rebase" });

		expect(await Bun.file(path.join(mainPath, "feature.txt")).exists()).toBe(true);
		expect(await Bun.file(path.join(mainPath, "main-change.txt")).exists()).toBe(true);
	});
});
