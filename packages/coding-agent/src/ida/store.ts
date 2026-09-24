import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, peekFile } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Number of leading bytes needed by {@link isExecutableHeader} (a full 64-byte DOS header for PE). */
export const EXECUTABLE_SNIFF_BYTES = 64;

/** Largest plausible `nfat_arch` for a fat Mach-O; Java class files (same magic) carry a version ≥ 45 there. */
const MAX_FAT_ARCHS = 30;
/** Size of the DOS header; `e_lfanew` (u32 LE at 0x3C) of a real DOS/PE image points at or past it. */
const DOS_HEADER_SIZE = 64;
const MAX_NAME_LENGTH = 64;
const LOCK_SUFFIX = ".lock";

/**
 * True when `header` starts with an ELF, thin Mach-O, or fat Mach-O magic, or holds a full DOS header
 * (`MZ`, ≥ 64 bytes, `e_lfanew` ≥ 64) so blobs that merely start with "MZ" are rejected.
 */
export function isExecutableHeader(header: Uint8Array): boolean {
	if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
		if (header.length < DOS_HEADER_SIZE) return false;
		const eLfanew = (header[0x3c] | (header[0x3d] << 8) | (header[0x3e] << 16) | (header[0x3f] << 24)) >>> 0;
		return eLfanew >= DOS_HEADER_SIZE;
	}
	if (header.length < 4) return false;
	const b0 = header[0];
	const b1 = header[1];
	const b2 = header[2];
	const b3 = header[3];
	if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
	if (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && (b3 === 0xce || b3 === 0xcf)) return true;
	if ((b0 === 0xce || b0 === 0xcf) && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) return true;
	if (b0 === 0xca && b1 === 0xfe && b2 === 0xba && (b3 === 0xbe || b3 === 0xbf)) {
		if (header.length < 8) return false;
		const nfatArch = ((header[4] << 24) | (header[5] << 16) | (header[6] << 8) | header[7]) >>> 0;
		return nfatArch >= 1 && nfatArch <= MAX_FAT_ARCHS;
	}
	return false;
}

/** True when `p` has an IDA database extension (`.i64`/`.idb`, case-insensitive). */
export function isIdaDatabasePath(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return ext === ".i64" || ext === ".idb";
}

/** Sniff the file header; false on any I/O error. */
export async function isExecutableFile(absPath: string): Promise<boolean> {
	try {
		return await peekFile(absPath, EXECUTABLE_SNIFF_BYTES, isExecutableHeader);
	} catch {
		return false;
	}
}

/** Where an IDB for a given source lives and how to open it. */
export interface IdbLocation {
	/** Registry key: `<sha16>-<name>` for store DBs, `<name>-<pathsha8>` for in-place DBs. */
	id: string;
	/** Directory holding the IDB (store dir, or the user's directory for in-place). */
	dir: string;
	/** Absolute path the user asked for (binary or `.i64`/`.idb`). */
	sourcePath: string;
	/** `store` = managed under the agent dir; `inplace` = user's own `.i64`/`.idb`. */
	kind: "store" | "inplace";
	/** Path passed to the worker's `open`; provisional for store DBs until {@link prepareStoreDir}. */
	openPath: string;
	/** Whether the worker must create a new database; provisional for store DBs until {@link prepareStoreDir}. */
	isNew: boolean;
	/** Path handed to `acquireFileLock` (lock file is `${lockTarget}.lock`). */
	lockTarget: string;
}

/** Replace characters outside `[A-Za-z0-9._-]` with `_` and cap at 64 chars. */
export function sanitizeIdbName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_NAME_LENGTH);
}

interface ContentHash {
	size: number;
	mtimeMs: number;
	sha: string;
}

const contentHashes = new Map<string, ContentHash>();

async function hashFileContent(absPath: string): Promise<string> {
	const stat = await fs.promises.stat(absPath);
	const cached = contentHashes.get(absPath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha;
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(absPath).stream()) {
		hasher.update(chunk);
	}
	const sha = hasher.digest("hex");
	contentHashes.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, sha });
	return sha;
}

/** Compute the IDB location for a binary (content-addressed store) or an existing `.i64`/`.idb` (in place). */
export async function locateIdb(sourcePath: string): Promise<IdbLocation> {
	const absPath = path.resolve(sourcePath);
	const name = sanitizeIdbName(path.basename(absPath));

	if (isIdaDatabasePath(absPath)) {
		const pathSha = new Bun.CryptoHasher("sha256").update(absPath).digest("hex");
		return {
			id: `${name}-${pathSha.slice(0, 8)}`,
			dir: path.dirname(absPath),
			sourcePath: absPath,
			kind: "inplace",
			openPath: absPath,
			isNew: false,
			lockTarget: absPath,
		};
	}

	const sha = await hashFileContent(absPath);
	const id = `${sha.slice(0, 16)}-${name}`;
	const dir = path.join(getAgentDir(), "idbs", id);
	// The lock file lives inside `dir`, and the lock is taken before `prepareStoreDir`.
	await fs.promises.mkdir(dir, { recursive: true });
	return {
		id,
		dir,
		sourcePath: absPath,
		kind: "store",
		openPath: path.join(dir, name),
		isNew: true,
		lockTarget: path.join(dir, "db"),
	};
}

/**
 * Validate an in-place location (refuses when IDA has it unpacked) or stage a store binary and settle `loc.openPath`/`loc.isNew`.
 * Call only while holding the lock on `loc.lockTarget` and only when the DB is not already open in this process.
 */
export async function prepareStoreDir(loc: IdbLocation): Promise<void> {
	if (loc.kind === "inplace") {
		const id0Path = path.join(loc.dir, `${path.basename(loc.openPath, path.extname(loc.openPath))}.id0`);
		if (await Bun.file(id0Path).exists()) {
			throw new ToolError(
				`${shortenPath(loc.openPath)} appears open in IDA (unpacked .id0 present); close it in IDA first`,
			);
		}
		return;
	}
	await fs.promises.mkdir(loc.dir, { recursive: true });

	const stagedName = sanitizeIdbName(path.basename(loc.sourcePath));
	const staged = path.join(loc.dir, stagedName);
	if (!(await Bun.file(staged).exists())) {
		await fs.promises.copyFile(loc.sourcePath, staged, fs.constants.COPYFILE_FICLONE);
	}

	const entries = (await fs.promises.readdir(loc.dir)).sort();
	const databases = entries.filter(entry => entry.toLowerCase().endsWith(".i64"));
	if (databases.length > 0) {
		// Prefer the DB IDA names after the staged input; unpacked `<stem>.id0`… siblings are left for IDA.
		const preferred = databases.find(entry => entry === `${stagedName}.i64`) ?? databases[0];
		loc.openPath = path.join(loc.dir, preferred);
		loc.isNew = false;
		return;
	}

	// No finished database: anything besides the staged input and the lock is a crashed-creation leftover.
	const lockName = `${path.basename(loc.lockTarget)}${LOCK_SUFFIX}`;
	await Promise.all(
		entries
			.filter(entry => entry !== stagedName && entry !== lockName)
			.map(entry => fs.promises.rm(path.join(loc.dir, entry), { recursive: true, force: true })),
	);
	loc.openPath = staged;
	loc.isNew = true;
}
