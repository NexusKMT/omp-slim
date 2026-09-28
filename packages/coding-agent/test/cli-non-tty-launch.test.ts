import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Launch-mode selection without a terminal on stdin (scripts, CI, `</dev/null`).
// Before: a bare or prompt-carrying launch chose interactive mode, booted the TUI
// against a closed stdin, and exited 129 with no output.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const TTY_ERROR = "interactive mode requires a terminal";
/** Credential-bearing variables that could hand the child a usable model. */
const CREDENTIAL_ENV =
	/(_API_KEY|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_CREDENTIALS|^AWS_PROFILE|^GOOGLE_CLOUD_PROJECT)$/;

interface LaunchRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function launchWithoutTerminal(tempDir: TempDir, args: string[]): Promise<LaunchRun> {
	const home = tempDir.join("home");
	fs.mkdirSync(home, { recursive: true });
	// Isolated home and no credentials: print mode can only end at the headless
	// "No models available" exit, which the interactive path never reaches.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (CREDENTIAL_ENV.test(key)) delete env[key];
	}
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"PI_CONFIG_FILES",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
	]) {
		delete env[key];
	}
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", "--no-extensions", ...args], {
		cwd: tempDir.path(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

// Each case cold-starts the CLI graph in a child process; the budget covers that transpile.
describe("launch without a terminal on stdin", () => {
	it("fails a bare launch with a usage error and exit 2", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bare-");
		const run = await launchWithoutTerminal(tempDir, []);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stdout).toBe("");
	}, 30_000);

	it("runs a prompt argument headless in print mode instead of the TUI", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-prompt-");
		const run = await launchWithoutTerminal(tempDir, ["say ok"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).toContain("No models available.");
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);

	it("reports an invalid enum value before the terminal requirement", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bad-mode-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --mode value: "bogus"');
		expect(run.stderr).not.toContain(TTY_ERROR);
	}, 30_000);

	it("delivers an extension-owned --mode before failing on the missing terminal", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-mode-");
		const extensionPath = tempDir.join("mode-extension.ts");
		// The TTY failure exits before any session event, so report the flag at exit.
		await Bun.write(
			extensionPath,
			[
				"export default function (pi) {",
				'\tpi.registerFlag("mode", { type: "string" });',
				'\tprocess.once("exit", () => process.stderr.write("EXT_MODE=" + pi.getFlag("mode") + "\\n"));',
				"}",
			].join("\n"),
		);
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "compact"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).not.toContain("Invalid --mode value");
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stderr).toContain("EXT_MODE=compact");
	}, 30_000);
});
