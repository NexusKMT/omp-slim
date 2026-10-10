import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability, resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/** Linked-worktree shape `vcs.git` resolves without invoking git. */
function linkWorktree(project: string, worktreeRoot: string): Promise<void> {
	const commonDir = path.join(project, ".git");
	const gitDir = path.join(commonDir, "worktrees", path.basename(worktreeRoot));
	return fs.mkdir(gitDir, { recursive: true }).then(async () => {
		await fs.mkdir(worktreeRoot, { recursive: true });
		await fs.writeFile(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
		await fs.writeFile(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`);
		await fs.writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`);
	});
}

describe("contextFiles.extra", () => {
	let tempDir = "";
	let tempHome = "";
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	const dirs: string[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ctx-home-"));
		dirs.push(tempHome);
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ctx-"));
		dirs.push(tempDir);
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		vi.restoreAllMocks();
		restoreEnv("HOME", originalHome);
		restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
		__resetDirsFromEnvForTests();
		await Promise.all(dirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	async function bind(extra: string[], cwd = tempDir): Promise<void> {
		const settings = await Settings.init({
			inMemory: true,
			cwd,
			overrides: { "contextFiles.extra": extra },
		});
		initializeWithSettings(settings);
	}

	test("loads a configured sibling beside AGENTS.md instead of replacing it", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		await bind(["AGENTS.local.md"]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		const names = result.items.map(file => path.basename(file.path));

		expect(names).toContain("AGENTS.md");
		expect(names).toContain("AGENTS.local.md");
		expect(result.items.find(file => file.path.endsWith("AGENTS.local.md"))?.content).toBe("# personal\n");
	});

	test("does not discover an unlisted local sibling", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		await bind([]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items.map(file => path.basename(file.path))).toEqual(["AGENTS.md"]);
	});

	test("drops only the extra file when its extension id is disabled", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				"contextFiles.extra": ["AGENTS.local.md"],
				disabledExtensions: ["context-file:project:AGENTS.local.md"],
			},
		});
		initializeWithSettings(settings);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			disabledExtensions: ["context-file:project:AGENTS.local.md"],
		});

		expect(result.items.map(file => path.basename(file.path))).toEqual(["AGENTS.md"]);
	});

	test("rejects a path entry when settings load", async () => {
		await expect(
			Settings.init({
				inMemory: true,
				cwd: tempDir,
				overrides: { "contextFiles.extra": ["../AGENTS.local.md"] },
			}),
		).rejects.toThrow(/file names, not paths/);
	});

	test("loads the primary checkout copy from a linked worktree without importing the primary AGENTS.md", async () => {
		const primary = path.join(tempDir, "primary");
		const worktree = path.join(tempDir, ".wt", "feature");
		await linkWorktree(primary, worktree);
		await fs.writeFile(path.join(primary, "AGENTS.md"), "# primary shared\n");
		await fs.writeFile(path.join(primary, "AGENTS.local.md"), "# primary personal\n");
		await fs.writeFile(path.join(worktree, "AGENTS.md"), "# worktree shared\n");
		await bind(["AGENTS.local.md"], worktree);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: worktree });
		const byPath = new Map(result.items.map(file => [file.path, file.content]));

		expect(byPath.get(path.join(worktree, "AGENTS.md"))).toBe("# worktree shared\n");
		expect(byPath.get(path.join(primary, "AGENTS.local.md"))).toBe("# primary personal\n");
		expect(byPath.has(path.join(primary, "AGENTS.md"))).toBe(false);
	});

	test("loads a user-agent-dir extra file without shadowing user AGENTS.md", async () => {
		const agentDir = path.join(tempHome, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "AGENTS.md"), "# user shared\n");
		await fs.writeFile(path.join(agentDir, "AGENTS.local.md"), "# user personal\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# project\n");
		await bind(["AGENTS.local.md"]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		const userLocal = result.items.find(file => file.path === path.join(agentDir, "AGENTS.local.md"));
		const userShared = result.items.find(file => file.path === path.join(agentDir, "AGENTS.md"));

		expect(userLocal?.level).toBe("user");
		expect(userLocal?.content).toBe("# user personal\n");
		expect(userShared?.content).toBe("# user shared\n");
	});
});
