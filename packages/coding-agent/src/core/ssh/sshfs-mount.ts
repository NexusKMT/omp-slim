import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config";
import { logger } from "../logger";
import { getControlDir, getControlPathTemplate, type SSHConnectionTarget } from "./connection-manager";

const REMOTE_DIR = join(homedir(), CONFIG_DIR_NAME, "remote");
const CONTROL_DIR = getControlDir();
const CONTROL_PATH = getControlPathTemplate();

const mountedPaths = new Set<string>();

function ensureDir(path: string, mode = 0o700): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode });
	}
	try {
		chmodSync(path, mode);
	} catch (err) {
		logger.debug("SSHFS dir chmod failed", { path, error: String(err) });
	}
}

function decodeOutput(buffer?: Uint8Array): string {
	if (!buffer || buffer.length === 0) return "";
	return new TextDecoder().decode(buffer).trim();
}

function getMountName(host: SSHConnectionTarget): string {
	const raw = (host.name ?? host.host).trim();
	const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

function getMountPath(host: SSHConnectionTarget): string {
	return join(REMOTE_DIR, getMountName(host));
}

function buildSshTarget(host: SSHConnectionTarget): string {
	return host.username ? `${host.username}@${host.host}` : host.host;
}

function buildSshfsArgs(host: SSHConnectionTarget): string[] {
	const args = [
		"-o",
		"reconnect",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${CONTROL_PATH}`,
		"-o",
		"ControlPersist=3600",
	];

	if (host.port) {
		args.push("-p", String(host.port));
	}

	if (host.keyPath) {
		args.push("-o", `IdentityFile=${host.keyPath}`);
	}

	return args;
}

function unmountPath(path: string): boolean {
	const fusermount = Bun.which("fusermount") ?? Bun.which("fusermount3");
	if (fusermount) {
		const result = Bun.spawnSync([fusermount, "-u", path], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		if (result.exitCode === 0) return true;
	}

	const umount = Bun.which("umount");
	if (!umount) return false;
	const result = Bun.spawnSync([umount, path], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	return result.exitCode === 0;
}

export function hasSshfs(): boolean {
	return Bun.which("sshfs") !== null;
}

export function isMounted(path: string): boolean {
	const mountpoint = Bun.which("mountpoint");
	if (!mountpoint) return false;
	const result = Bun.spawnSync([mountpoint, "-q", path], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

export async function mountRemote(host: SSHConnectionTarget, remotePath = "/"): Promise<string | undefined> {
	if (!hasSshfs()) return undefined;

	ensureDir(REMOTE_DIR);
	ensureDir(CONTROL_DIR);

	const mountPath = getMountPath(host);
	ensureDir(mountPath);

	if (isMounted(mountPath)) {
		mountedPaths.add(mountPath);
		return mountPath;
	}

	const target = `${buildSshTarget(host)}:${remotePath}`;
	const result = Bun.spawnSync(["sshfs", ...buildSshfsArgs(host), target, mountPath], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (result.exitCode !== 0) {
		const detail = decodeOutput(result.stderr);
		const suffix = detail ? `: ${detail}` : "";
		throw new Error(`Failed to mount ${target}${suffix}`);
	}

	mountedPaths.add(mountPath);
	return mountPath;
}

export async function unmountRemote(host: SSHConnectionTarget): Promise<boolean> {
	const mountPath = getMountPath(host);
	if (!isMounted(mountPath)) {
		mountedPaths.delete(mountPath);
		return false;
	}

	const success = unmountPath(mountPath);
	if (success) {
		mountedPaths.delete(mountPath);
	}

	return success;
}

export async function unmountAll(): Promise<void> {
	for (const mountPath of Array.from(mountedPaths)) {
		unmountPath(mountPath);
	}
	mountedPaths.clear();
}
