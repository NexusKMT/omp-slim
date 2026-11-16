#!/usr/bin/env bun
/**
 * `bun setup` entrypoint. Chains the four setup steps (install → native
 * addon build → coding-agent link → omp link). The native host build uses
 * Cargo/N-API via `packages/natives/scripts/build-bindings.ts`.
 */
import * as path from "node:path";
const repoRoot = path.join(import.meta.dir, "..");

interface Step {
	label: string;
	cmd: string[];
	cwd?: string;
}

const steps: Step[] = [
	{ label: "bun install", cmd: ["bun", "install"] },
	{ label: "build:native", cmd: ["bun", "run", "build:native"] },
	{ label: "coding-agent link", cmd: ["bun", "--cwd=packages/coding-agent", "link"] },
	{ label: "link omp", cmd: ["sh", "scripts/link-omp.sh"] },
];

for (const step of steps) {
	console.log(`\n▶ ${step.label}`);
	const proc = Bun.spawn(step.cmd, {
		cwd: step.cwd ?? repoRoot,
		env: process.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
		process.exit(exitCode || 1);
	}
}
