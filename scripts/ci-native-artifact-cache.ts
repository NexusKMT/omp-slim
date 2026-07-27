#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const CACHE_ENV = "OMP_NATIVE_CACHE_DIR";
const COMPLETE_FILE = ".complete";

function validateSegment(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error(`Invalid ${label} ${JSON.stringify(value)}`);
	}
}

async function writeOutput(name: string, value: string): Promise<void> {
	const outputPath = Bun.env.GITHUB_OUTPUT;
	if (outputPath) {
		await fs.appendFile(outputPath, `${name}=${value}\n`);
	}
}

async function completedFiles(artifactDir: string): Promise<string[] | null> {
	try {
		const text = await Bun.file(path.join(artifactDir, COMPLETE_FILE)).text();
		const files = text.split("\n").filter(Boolean);
		if (files.length === 0 || files.some(file => path.basename(file) !== file || !file.endsWith(".node"))) {
			return null;
		}
		for (const file of files) {
			if (!(await Bun.file(path.join(artifactDir, file)).exists())) return null;
		}
		return files;
	} catch {
		return null;
	}
}

async function save(cacheRoot: string, hash: string, artifactName: string, sourceDir: string): Promise<void> {
	validateSegment(hash, "source hash");
	validateSegment(artifactName, "artifact name");
	const entries = await fs.readdir(sourceDir, { withFileTypes: true });
	const files = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".node"))
		.map(entry => entry.name)
		.sort();
	if (files.length === 0) throw new Error(`No native addons found in ${sourceDir}`);

	const hashDir = path.join(cacheRoot, hash);
	const artifactDir = path.join(hashDir, artifactName);
	if (await completedFiles(artifactDir)) {
		console.log(`Native artifact cache already populated: ${artifactName}`);
		return;
	}

	await fs.mkdir(hashDir, { recursive: true });
	const stagingDir = path.join(hashDir, `${artifactName}.tmp-${process.pid}-${crypto.randomUUID()}`);
	await fs.mkdir(stagingDir);
	try {
		for (const file of files) {
			await fs.copyFile(path.join(sourceDir, file), path.join(stagingDir, file));
		}
		await Bun.write(path.join(stagingDir, COMPLETE_FILE), `${files.join("\n")}\n`);
		try {
			await fs.rename(stagingDir, artifactDir);
		} catch (error) {
			if (!(await completedFiles(artifactDir))) throw error;
			await fs.rm(stagingDir, { recursive: true, force: true });
		}
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
	console.log(`Saved native artifact cache: ${artifactName} (${files.join(", ")})`);
}

async function restore(
	cacheRoot: string,
	hash: string,
	destination: string,
	artifactNames: string[],
): Promise<boolean> {
	validateSegment(hash, "source hash");
	if (artifactNames.length === 0) throw new Error("At least one artifact name is required");

	const sources: Array<{ dir: string; files: string[] }> = [];
	for (const artifactName of artifactNames) {
		validateSegment(artifactName, "artifact name");
		const dir = path.join(cacheRoot, hash, artifactName);
		const files = await completedFiles(dir);
		if (!files) return false;
		sources.push({ dir, files });
	}

	await fs.mkdir(destination, { recursive: true });
	for (const source of sources) {
		for (const file of source.files) {
			await fs.copyFile(path.join(source.dir, file), path.join(destination, file));
		}
	}
	console.log(`Restored native artifacts from local cache: ${artifactNames.join(", ")}`);
	return true;
}

async function main(): Promise<void> {
	const [mode, hash, first, ...rest] = process.argv.slice(2);
	if ((mode !== "save" && mode !== "restore") || !hash || !first) {
		throw new Error(
			"Usage: ci-native-artifact-cache.ts save <hash> <artifact-name> [source-dir] | restore <hash> <destination> <artifact-name>...",
		);
	}

	const cacheRoot = Bun.env[CACHE_ENV]?.trim();
	if (!cacheRoot) {
		if (mode === "restore") await writeOutput("hit", "false");
		console.log(`Native artifact cache disabled: ${CACHE_ENV} is unset`);
		return;
	}

	if (mode === "save") {
		await save(cacheRoot, hash, first, rest[0] ?? "packages/natives/native");
		return;
	}

	const hit = await restore(cacheRoot, hash, first, rest);
	await writeOutput("hit", String(hit));
	if (!hit) console.log(`Native artifact cache miss: ${rest.join(", ")}`);
}

if (import.meta.main) await main();
