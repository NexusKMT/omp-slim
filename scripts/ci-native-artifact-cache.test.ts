import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const script = path.join(import.meta.dir, "ci-native-artifact-cache.ts");
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-cache-test-"));
	tempRoots.push(dir);
	return dir;
}

async function run(args: string[], cacheDir: string, outputPath?: string): Promise<string> {
	const proc = Bun.spawn([process.execPath, script, ...args], {
		cwd: path.join(import.meta.dir, ".."),
		env: {
			...process.env,
			OMP_NATIVE_CACHE_DIR: cacheDir,
			GITHUB_OUTPUT: outputPath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`cache command failed (${exitCode}): ${stderr}`);
	return stdout;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("CI native artifact cache", () => {
	it("restores a complete artifact set without unrelated build output", async () => {
		const root = await tempDir();
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		const output = path.join(root, "github-output");
		await fs.mkdir(source);
		await Promise.all([
			Bun.write(path.join(source, "pi_natives.linux-x64.node"), "baseline"),
			Bun.write(path.join(source, "build.log"), "not an artifact"),
		]);

		await run(["save", "abcdef12", "pi-natives-linux-x64-baseline-habcdef12", source], root);
		await run(["restore", "abcdef12", destination, "pi-natives-linux-x64-baseline-habcdef12"], root, output);

		expect(await Bun.file(output).text()).toBe("hit=true\n");
		expect(await Bun.file(path.join(destination, "pi_natives.linux-x64.node")).text()).toBe("baseline");
		expect(await Bun.file(path.join(destination, "build.log")).exists()).toBe(false);
	});

	it("reports a miss and copies nothing unless every requested artifact is complete", async () => {
		const root = await tempDir();
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		const output = path.join(root, "github-output");
		await fs.mkdir(source);
		await Bun.write(path.join(source, "pi_natives.linux-x64.node"), "baseline");
		await run(["save", "abcdef12", "pi-natives-linux-x64-baseline-habcdef12", source], root);

		await run(
			[
				"restore",
				"abcdef12",
				destination,
				"pi-natives-linux-x64-baseline-habcdef12",
				"pi-natives-linux-x64-modern-habcdef12",
			],
			root,
			output,
		);

		expect(await Bun.file(output).text()).toBe("hit=false\n");
		expect(await Bun.file(destination).exists()).toBe(false);
	});
});
