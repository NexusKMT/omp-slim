import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/** Maps an absolute Windows drive path to the drive's default WSL mount. */
export function windowsPathToWslMount(filePath: string): string | undefined {
	const normalized = path.win32.normalize(filePath.trim());
	const match = WINDOWS_DRIVE_PATH.exec(normalized);
	if (!match) return undefined;
	const [, drive, rest] = match;
	const segments = rest.split("\\").filter(Boolean);
	return path.posix.join("/mnt", drive!.toLowerCase(), ...segments);
}

/** Test whether a path is fully qualified: absolute in POSIX terms. */
export function isFullyQualifiedPath(filePath: string): boolean {
	return path.posix.isAbsolute(filePath);
}

/** Expands a leading `~` (`~`, `~/…`, `~name`) to `home`, the user's home directory by default. */
export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}
