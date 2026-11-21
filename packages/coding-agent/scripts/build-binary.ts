#!/usr/bin/env bun

import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const shouldAdhocSign =
		process.platform === "darwin" &&
		(!crossBuild || crossBuild.platform === "darwin") &&
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputPath = path.join(packageDir, "dist", outName);
	await compileCodingAgent({
		repoRoot,
		entrypoint: path.join(packageDir, "src", "cli.ts"),
		outfile: outputPath,
		native: crossBuild ?? { platform: process.platform, arch: process.arch },
		target: crossBuild?.target,
		executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
		skipBuiltinCodesign: shouldAdhocSign,
	});

	if (shouldAdhocSign) {
		const codesignStarted = performance.now();
		await runCommand([
			"codesign",
			"--force",
			"--sign",
			"-",
			"--entitlements",
			path.join(repoRoot, "scripts", "macos-entitlements.plist"),
			outputPath,
		]);
		if (Bun.env.OMP_BUILD_TIMINGS === "1") {
			console.log(`CLI codesign: ${(performance.now() - codesignStarted).toFixed(0)} ms`);
		}
	}
}

if (import.meta.main) await main();
