/**
 * One-time migrations that run on startup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { getAgentDir, getBinDir } from "./config";

/**
 * Migrate PI_* environment variables to OMP_* equivalents.
 * If PI_XX is set and OMP_XX is not, set OMP_XX to PI_XX's value.
 * This provides backwards compatibility for users with existing PI_* env vars.
 *
 * @returns Array of PI_* env var names that were migrated
 */
export function migrateEnvVars(): string[] {
	const migrated: string[] = [];
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PI_") && value !== undefined) {
			const ompKey = `OMP_${key.slice(3)}`; // PI_FOO -> OMP_FOO
			if (process.env[ompKey] === undefined) {
				process.env[ompKey] = value;
				migrated.push(key);
			}
		}
	}
	return migrated;
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.omp/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.omp/agent/ instead of
 * ~/.omp/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/badlogic/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			mkdirSync(correctDir, { recursive: true });

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Run all migrations. Called once on startup.
 *
 * @param _cwd - Current working directory (reserved for future project-local migrations)
 * @returns Object with migration results
 */
export async function runMigrations(_cwd: string): Promise<{
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
}> {
	// First: migrate env vars (before anything else reads them)
	const migratedEnvVars = migrateEnvVars();

	// Then: run data migrations
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();

	// Collect deprecation warnings
	const deprecationWarnings: string[] = [];
	if (migratedEnvVars.length > 0) {
		for (const envVar of migratedEnvVars) {
			const ompVar = `OMP_${envVar.slice(3)}`;
			deprecationWarnings.push(`${envVar} is deprecated. Use ${ompVar} instead.`);
		}
	}

	return { migratedAuthProviders, deprecationWarnings };
}

/**
 * Display deprecation warnings to the user in interactive mode.
 *
 * @param warnings - Array of deprecation warning messages
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	console.log(chalk.yellow("\n⚠ Deprecation Warnings:"));
	for (const warning of warnings) {
		console.log(chalk.yellow(`  • ${warning}`));
	}
	console.log();
}
