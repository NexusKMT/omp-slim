#!/usr/bin/env bun
import * as path from "node:path";
import { compareSecurityProducers, parseSecurityScanBundle } from "../src/security";

async function readBundle(directory: string) {
	const root = path.resolve(directory);
	const scan = JSON.parse(await Bun.file(path.join(root, "scan.json")).text()) as unknown;
	const findings = JSON.parse(await Bun.file(path.join(root, "findings.json")).text()) as unknown;
	const report = await Bun.file(path.join(root, "report.md"))
		.text()
		.catch(() => undefined);
	const sarifText = await Bun.file(path.join(root, "results.sarif"))
		.text()
		.catch(() => undefined);
	return parseSecurityScanBundle({
		scan,
		findings,
		report,
		sarif: sarifText ? (JSON.parse(sarifText) as Record<string, unknown>) : undefined,
	});
}

const [referenceDirectory, candidateDirectory, outputPath] = process.argv.slice(2);
if (!referenceDirectory || !candidateDirectory) {
	process.stderr.write(
		"Usage: bun scripts/security-compare.ts <reference-scan-dir> <candidate-scan-dir> [output.json]\n",
	);
	process.exit(2);
}
const report = compareSecurityProducers(await readBundle(referenceDirectory), await readBundle(candidateDirectory));
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await Bun.write(path.resolve(outputPath), serialized);
else process.stdout.write(serialized);
