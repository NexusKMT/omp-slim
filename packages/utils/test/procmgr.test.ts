import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "../src/dirs";
import { getShellArgs, getShellConfig, isPosixShell } from "../src/procmgr";

describe("getShellConfig", () => {
	it("directs invalid custom shell paths to the canonical config file", () => {
		const missingShell = path.join(os.tmpdir(), `omp-missing-shell-${process.pid}`, "bash");
		const configPath = path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
		expect(() => getShellConfig(missingShell)).toThrow(
			`Custom shell path not found: ${missingShell}\nPlease update shellPath in ${configPath}`,
		);
	});

	it("falls back to the default shell once a custom shell path is cleared", () => {
		const defaultShell = getShellConfig().shell;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-custom-shell-"));
		try {
			const customShell = path.join(dir, "bash");
			fs.writeFileSync(customShell, "");
			expect(getShellConfig(customShell).shell).toBe(customShell);
			const cleared = getShellConfig();
			expect(cleared.shell).toBe(defaultShell);
			expect(cleared.env.SHELL).toBe(defaultShell);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("refreshShellConfigCache", () => {
	const procmgrPath = path.join(import.meta.dir, "..", "src", "procmgr.ts");
	const dirsPath = path.join(import.meta.dir, "..", "src", "dirs.ts");
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function tempProject(dotenv: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refresh-project-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, ".env"), dotenv);
		return dir;
	}

	// Dotenv provenance comes from the launch environment and the launch project's
	// dotenv files, so each case runs in a fresh process launched in `cwd`.
	async function probe(cwd: string, env: Record<string, string | undefined>, lines: string[]): Promise<unknown> {
		const script = [
			`import { getShellConfig, refreshShellConfigCache } from ${JSON.stringify(procmgrPath)};`,
			`import { setProjectDir } from ${JSON.stringify(dirsPath)};`,
			...lines,
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: { ...process.env, NODE_ENV: undefined, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	}

	// Knowing which names the launcher set needs /proc/self/environ.
	it.skipIf(process.platform !== "linux")(
		"keeps a launcher-exported value the project's dotenv file repeats, and drops dotenv-only values",
		async () => {
			const project = tempProject("OMP_REFRESH_SHARED=same\nOMP_REFRESH_DOTENV_ONLY=from-dotenv\n");
			const result = await probe(project, { OMP_REFRESH_SHARED: "same", OMP_REFRESH_DOTENV_ONLY: undefined }, [
				"refreshShellConfigCache();",
				"const env = getShellConfig().env;",
				"process.stdout.write(JSON.stringify({",
				"  shared: env.OMP_REFRESH_SHARED ?? null,",
				"  dotenvOnly: env.OMP_REFRESH_DOTENV_ONLY ?? null,",
				"  loaded: process.env.OMP_REFRESH_DOTENV_ONLY ?? null,",
				"}));",
			]);
			expect(result).toEqual({ shared: "same", dotenvOnly: null, loaded: "from-dotenv" });
		},
	);

	// The filter keeps the project the spawn environment was first built or captured
	// in, so the first refresh can come after a switch without changing it.
	for (const [first, firstLine] of [
		["a refresh", "refreshShellConfigCache();"],
		["a build", "getShellConfig();"],
	] as const) {
		it(`keeps the launch project's dotenv values out of another project's session after ${first} in the launch project`, async () => {
			const launch = tempProject("OMP_REFRESH_LAUNCH_SECRET=a-secret\n");
			const other = tempProject("");
			const result = await probe(launch, { OMP_REFRESH_LAUNCH_SECRET: undefined }, [
				firstLine,
				`setProjectDir(${JSON.stringify(other)});`,
				"refreshShellConfigCache();",
				"process.stdout.write(JSON.stringify({",
				"  child: getShellConfig().env.OMP_REFRESH_LAUNCH_SECRET ?? null,",
				"  loaded: process.env.OMP_REFRESH_LAUNCH_SECRET ?? null,",
				"}));",
			]);
			expect(result).toEqual({ child: null, loaded: "a-secret" });
		});
	}
});

describe("isPosixShell", () => {
	it("recognizes only known POSIX-quoting shell executable basenames", () => {
		for (const shell of ["sh", "/bin/BaSh", "/bin/dash", "/bin/ash", "/usr/bin/ksh", "/usr/bin/zsh"]) {
			expect(isPosixShell(shell)).toBe(true);
		}

		for (const shell of [
			"",
			"fish",
			"/usr/bin/csh",
			"/usr/bin/tcsh",
			"nu",
			"busybox",
			"/usr/local/bin/bash-wrapper",
		]) {
			expect(isPosixShell(shell)).toBe(false);
		}
	});
});

describe("getShellArgs", () => {
	it("uses -c with -l for POSIX shells", () => {
		expect(getShellArgs({})).toEqual(["-l", "-c"]);
	});

	it("maps the no-login env gate to -c", () => {
		expect(getShellArgs({ PI_BASH_NO_LOGIN: "1" })).toEqual(["-c"]);
	});
});
