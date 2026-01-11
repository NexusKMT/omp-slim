/**
 * Shared helpers for discovery providers.
 */

import { join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import { readDirEntries, readFile } from "../capability/fs";
import type { Skill, SkillFrontmatter } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

/**
 * Standard paths for each config source.
 */
export const SOURCE_PATHS = {
	native: {
		userBase: ".omp",
		userAgent: ".omp/agent",
		projectDir: ".omp",
		aliases: [".pi"], // .pi is an alias for backwards compat
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null, // Cline uses root-level .clinerules
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

export type SourceId = keyof typeof SOURCE_PATHS;

/**
 * Get user-level path for a source.
 */
export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return join(ctx.home, paths.userAgent, subpath);
}

/**
 * Get project-level path for a source (cwd only).
 */
export function getProjectPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.projectDir) return null;

	return join(ctx.cwd, paths.projectDir, subpath);
}

/**
 * Create source metadata for an item.
 */
export function createSourceMeta(provider: string, path: string, level: "user" | "project"): SourceMeta {
	return {
		provider,
		providerName: "", // Filled in by registry
		path: resolve(path),
		level,
	};
}

/**
 * Strip YAML frontmatter from content.
 * Returns { frontmatter, body, raw }
 */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
	raw: string;
} {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const raw = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const frontmatter = parseYAML(raw) as Record<string, unknown> | null;
		return { frontmatter: frontmatter ?? {}, body, raw };
	} catch {
		// Fallback to empty frontmatter on parse error
		return { frontmatter: {}, body, raw };
	}
}

export async function loadSkillsFromDir(
	_ctx: LoadContext,
	options: {
		dir: string;
		providerId: string;
		level: "user" | "project";
		requireDescription?: boolean;
	},
): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { dir, level, providerId, requireDescription = false } = options;

	const entries = await readDirEntries(dir);
	const skillDirs = entries.filter(
		(entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
	);

	const results = await Promise.all(
		skillDirs.map(async (entry) => {
			const skillFile = join(dir, entry.name, "SKILL.md");
			const content = await readFile(skillFile);
			if (!content) {
				return { item: null as Skill | null, warning: null as string | null };
			}

			const { frontmatter, body } = parseFrontmatter(content);
			if (requireDescription && !frontmatter.description) {
				return { item: null as Skill | null, warning: null as string | null };
			}

			return {
				item: {
					name: (frontmatter.name as string) || entry.name,
					path: skillFile,
					content: body,
					frontmatter: frontmatter as SkillFrontmatter,
					level,
					_source: createSourceMeta(providerId, skillFile, level),
				},
				warning: null as string | null,
			};
		}),
	);

	for (const result of results) {
		if (result.warning) warnings.push(result.warning);
		if (result.item) items.push(result.item);
	}

	return { items, warnings };
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? process.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		return `\${${varName}}`;
	});
}

/**
 * Recursively expand environment variables in an object.
 */
export function expandEnvVarsDeep<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => expandEnvVarsDeep(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsDeep(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Load files from a directory matching a pattern.
 */
export async function loadFilesFromDir<T>(
	_ctx: LoadContext,
	dir: string,
	provider: string,
	level: "user" | "project",
	options: {
		/** File extensions to match (without dot) */
		extensions?: string[];
		/** Transform file to item (return null to skip) */
		transform: (name: string, content: string, path: string, source: SourceMeta) => T | null;
		/** Whether to recurse into subdirectories */
		recursive?: boolean;
	},
): Promise<LoadResult<T>> {
	const entries = await readDirEntries(dir);

	const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));

	const directories = options.recursive ? visibleEntries.filter((entry) => entry.isDirectory()) : [];

	const files = visibleEntries
		.filter((entry) => entry.isFile())
		.filter((entry) => {
			if (!options.extensions) return true;
			return options.extensions.some((ext) => entry.name.endsWith(`.${ext}`));
		});

	const [subResults, fileResults] = await Promise.all([
		Promise.all(directories.map((entry) => loadFilesFromDir(_ctx, join(dir, entry.name), provider, level, options))),
		Promise.all(
			files.map(async (entry) => {
				const path = join(dir, entry.name);
				const content = await readFile(path);
				return { entry, path, content };
			}),
		),
	]);

	const items: T[] = [];
	const warnings: string[] = [];

	for (const subResult of subResults) {
		items.push(...subResult.items);
		if (subResult.warnings) warnings.push(...subResult.warnings);
	}

	for (const { entry, path, content } of fileResults) {
		if (content === null) {
			warnings.push(`Failed to read file: ${path}`);
			continue;
		}

		const source = createSourceMeta(provider, path, level);

		try {
			const item = options.transform(entry.name, content, path, source);
			if (item !== null) {
				items.push(item);
			}
		} catch (err) {
			warnings.push(`Failed to parse ${path}: ${err}`);
		}
	}

	return { items, warnings };
}

/**
 * Parse JSON safely.
 */
export function parseJSON<T>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Calculate depth of target directory relative to current working directory.
 * Depth is the number of directory levels from cwd to target.
 * - Positive depth: target is above cwd (parent/ancestor)
 * - Zero depth: target is cwd
 * - This uses path splitting to count directory levels
 */
export function calculateDepth(cwd: string, targetDir: string, separator: string): number {
	return cwd.split(separator).length - targetDir.split(separator).length;
}

interface ExtensionModuleManifest {
	extensions?: string[];
}

async function readExtensionModuleManifest(
	_ctx: LoadContext,
	packageJsonPath: string,
): Promise<ExtensionModuleManifest | null> {
	const content = await readFile(packageJsonPath);
	if (!content) return null;

	const pkg = parseJSON<{ omp?: ExtensionModuleManifest; pi?: ExtensionModuleManifest }>(content);
	const manifest = pkg?.omp ?? pkg?.pi;
	if (manifest && typeof manifest === "object") {
		return manifest;
	}
	return null;
}

function isExtensionModuleFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Discover extension module entry points in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
export async function discoverExtensionModulePaths(ctx: LoadContext, dir: string): Promise<string[]> {
	const discovered: string[] = [];
	const entries = await readDirEntries(dir);

	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

		const entryPath = join(dir, entry.name);

		// 1. Direct files: *.ts or *.js
		if (entry.isFile() && isExtensionModuleFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		// 2 & 3. Subdirectories
		if (entry.isDirectory()) {
			const subEntries = await readDirEntries(entryPath);
			const subFileNames = new Set(subEntries.filter((e) => e.isFile()).map((e) => e.name));

			// Check for package.json with "omp"/"pi" field first
			if (subFileNames.has("package.json")) {
				const packageJsonPath = join(entryPath, "package.json");
				const manifest = await readExtensionModuleManifest(ctx, packageJsonPath);
				if (manifest?.extensions && Array.isArray(manifest.extensions)) {
					for (const extPath of manifest.extensions) {
						const resolvedExtPath = resolve(entryPath, extPath);
						const content = await readFile(resolvedExtPath);
						if (content !== null) {
							discovered.push(resolvedExtPath);
						}
					}
					continue;
				}
			}

			// Check for index.ts or index.js
			if (subFileNames.has("index.ts")) {
				discovered.push(join(entryPath, "index.ts"));
			} else if (subFileNames.has("index.js")) {
				discovered.push(join(entryPath, "index.js"));
			}
		}
	}

	return discovered;
}

/**
 * Derive a stable extension name from a path.
 */
export function getExtensionNameFromPath(extensionPath: string): string {
	const base = extensionPath.replace(/\\/g, "/").split("/").pop() ?? extensionPath;

	if (base === "index.ts" || base === "index.js") {
		const parts = extensionPath.replace(/\\/g, "/").split("/");
		const parent = parts[parts.length - 2];
		return parent ?? base;
	}

	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		return base.slice(0, dot);
	}

	return base;
}
