import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadClaudeMd } from "@oh-my-pi/pi-coding-agent/discovery/claude-md";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function writeClaude(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("standalone CLAUDE.md discovery", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-md-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("finds workspace CLAUDE.md above a nested repository without loading home context", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(home, "repos", "writer");
		const repoRoot = path.join(workspaceRoot, "internal", "service");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });

		const repoClaude = path.join(repoRoot, "CLAUDE.md");
		const workspaceClaude = path.join(workspaceRoot, "CLAUDE.md");
		const homeClaude = path.join(home, "CLAUDE.md");
		writeClaude(repoClaude, "repo context");
		writeClaude(workspaceClaude, "workspace context");
		writeClaude(homeClaude, "home context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadClaudeMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoClaude, workspaceClaude]);
	});

	test("loads cwd and intermediate context with no repository root under home", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(home, "workspace");
		const intermediate = path.join(workspaceRoot, "packages");
		const cwd = path.join(intermediate, "service");
		fs.mkdirSync(cwd, { recursive: true });

		const cwdClaude = path.join(cwd, "CLAUDE.md");
		const intermediateClaude = path.join(intermediate, "CLAUDE.md");
		const homeClaude = path.join(home, "CLAUDE.md");
		writeClaude(cwdClaude, "cwd context");
		writeClaude(intermediateClaude, "intermediate context");
		writeClaude(homeClaude, "home context");

		const context: LoadContext = { cwd, home, repoRoot: null };
		const result = await loadClaudeMd(context);

		expect(result.items.map(file => file.path)).toEqual([cwdClaude, intermediateClaude, homeClaude]);
	});

	test("includes home context when the repository root is above home", async () => {
		const workspaceRoot = path.join(tempDir, "workspace");
		const home = path.join(workspaceRoot, "user");
		const repoRoot = workspaceRoot;
		const cwd = path.join(home, "project");
		fs.mkdirSync(cwd, { recursive: true });

		const repoClaude = path.join(repoRoot, "CLAUDE.md");
		const homeClaude = path.join(home, "CLAUDE.md");
		writeClaude(repoClaude, "repo context");
		writeClaude(homeClaude, "home context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadClaudeMd(context);

		expect(result.items.map(file => file.path)).toEqual([homeClaude, repoClaude]);
	});

	test("keeps the repository root boundary when the repository is outside home", async () => {
		const home = path.join(tempDir, "home");
		const workspaceRoot = path.join(tempDir, "workspace");
		const repoRoot = path.join(workspaceRoot, "service");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });

		const repoClaude = path.join(repoRoot, "CLAUDE.md");
		const workspaceClaude = path.join(workspaceRoot, "CLAUDE.md");
		writeClaude(repoClaude, "repo context");
		writeClaude(workspaceClaude, "workspace context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadClaudeMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoClaude]);
	});

	test("skips CLAUDE.md inside a hidden owner directory", async () => {
		const home = path.join(tempDir, "home");
		const repoRoot = path.join(home, "repo");
		const hiddenRoot = path.join(repoRoot, ".hidden");
		const cwd = path.join(hiddenRoot, "service");
		fs.mkdirSync(cwd, { recursive: true });

		const hiddenClaude = path.join(hiddenRoot, "CLAUDE.md");
		const repoClaude = path.join(repoRoot, "CLAUDE.md");
		writeClaude(hiddenClaude, "hidden context");
		writeClaude(repoClaude, "repo context");

		const context: LoadContext = { cwd, home, repoRoot };
		const result = await loadClaudeMd(context);

		expect(result.items.map(file => file.path)).toEqual([repoClaude]);
	});
});
