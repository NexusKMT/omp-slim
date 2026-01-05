import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function runGit(args: string[], cwd: string): GitRunResult {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: Buffer.from(result.stdout ?? []).toString(),
		stderr: Buffer.from(result.stderr ?? []).toString(),
		exitCode: result.exitCode ?? 0,
	};
}

export function createTestRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-tool-test-"));
	let result = runGit(["init"], dir);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr);
	}
	result = runGit(["config", "user.email", "test@example.com"], dir);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	result = runGit(["config", "user.name", "Test User"], dir);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return dir;
}

export function writeFile(path: string, content: string): void {
	writeFileSync(path, content, "utf-8");
}

export function cleanupRepo(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}
