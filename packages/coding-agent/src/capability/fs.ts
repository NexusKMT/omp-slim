import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, Dirent[]>();

function resolvePath(path: string): string {
	return resolve(path);
}

export async function readFile(path: string): Promise<string | null> {
	const abs = resolvePath(path);
	if (contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	try {
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(path: string): Promise<Dirent[]> {
	const abs = resolvePath(path);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export async function readDir(path: string): Promise<string[]> {
	const entries = await readDirEntries(path);
	return entries.map((entry) => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find((e) => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return join(current, name);
			if (dir && entry.isDirectory()) return join(current, name);
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(path: string): void {
	const abs = resolvePath(path);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
