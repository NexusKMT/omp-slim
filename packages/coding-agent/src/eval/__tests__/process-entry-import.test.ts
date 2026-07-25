import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("imports the CLI entry graph without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../../../test/fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});

it("starts ordinary CLI paths without evaluating the computer worker entry", async () => {
	const cliPath = path.resolve(import.meta.dir, "../../cli.ts");
	for (const args of [
		["--no-addons", cliPath, "--version"],
		[cliPath, "--help"],
	]) {
		const proc = Bun.spawn([process.execPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode, `${args.at(-1)}: ${stderr}`).toBe(0);
	}
});

it("dispatches the computer worker through its dedicated process entry", async () => {
	const fixture = path.resolve(import.meta.dir, "../../../test/fixtures/computer-worker-process-entry.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"type":"pong","id":"computer-process-entry"}\n');
});
