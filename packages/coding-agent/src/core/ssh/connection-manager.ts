import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config";
import { logger } from "../logger";

export interface SSHConnectionTarget {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
}

const CONTROL_DIR = join(homedir(), CONFIG_DIR_NAME, "ssh-control");
const CONTROL_PATH = join(CONTROL_DIR, "%h.sock");

const activeHosts = new Map<string, SSHConnectionTarget>();
const pendingConnections = new Map<string, Promise<void>>();

function ensureControlDir(): void {
	if (!existsSync(CONTROL_DIR)) {
		mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
	}
	try {
		chmodSync(CONTROL_DIR, 0o700);
	} catch (err) {
		logger.debug("SSH control dir chmod failed", { path: CONTROL_DIR, error: String(err) });
	}
}

function validateKeyPermissions(keyPath?: string): void {
	if (!keyPath) return;
	if (!existsSync(keyPath)) {
		throw new Error(`SSH key not found: ${keyPath}`);
	}
	const stats = statSync(keyPath);
	if (!stats.isFile()) {
		throw new Error(`SSH key is not a file: ${keyPath}`);
	}
	const mode = stats.mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(`SSH key permissions must be 600 or stricter: ${keyPath}`);
	}
}

function buildSshTarget(host: SSHConnectionTarget): string {
	return host.username ? `${host.username}@${host.host}` : host.host;
}

function buildCommonArgs(host: SSHConnectionTarget): string[] {
	const args = [
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${CONTROL_PATH}`,
		"-o",
		"ControlPersist=3600",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
	];

	if (host.port) {
		args.push("-p", String(host.port));
	}
	if (host.keyPath) {
		args.push("-i", host.keyPath);
	}

	return args;
}

function decodeOutput(buffer?: Uint8Array): string {
	if (!buffer || buffer.length === 0) return "";
	return new TextDecoder().decode(buffer).trim();
}

function runSshSync(args: string[]): { exitCode: number | null; stderr: string } {
	const result = Bun.spawnSync(["ssh", ...args], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});

	return { exitCode: result.exitCode, stderr: decodeOutput(result.stderr) };
}

function ensureSshBinary(): void {
	if (!Bun.which("ssh")) {
		throw new Error("ssh binary not found on PATH");
	}
}

export function buildRemoteCommand(host: SSHConnectionTarget, command: string): string[] {
	validateKeyPermissions(host.keyPath);
	return [...buildCommonArgs(host), buildSshTarget(host), command];
}

export async function ensureConnection(host: SSHConnectionTarget): Promise<void> {
	const key = host.name;
	const pending = pendingConnections.get(key);
	if (pending) {
		await pending;
		return;
	}

	const promise = (async () => {
		ensureSshBinary();
		ensureControlDir();
		validateKeyPermissions(host.keyPath);

		const target = buildSshTarget(host);
		const check = runSshSync(["-O", "check", ...buildCommonArgs(host), target]);
		if (check.exitCode === 0) {
			activeHosts.set(key, host);
			return;
		}

		const start = runSshSync(["-M", "-N", "-f", ...buildCommonArgs(host), target]);
		if (start.exitCode !== 0) {
			const detail = start.stderr ? `: ${start.stderr}` : "";
			throw new Error(`Failed to start SSH master for ${target}${detail}`);
		}

		activeHosts.set(key, host);
	})();

	pendingConnections.set(key, promise);
	try {
		await promise;
	} finally {
		pendingConnections.delete(key);
	}
}

function closeConnectionInternal(host: SSHConnectionTarget): void {
	const target = buildSshTarget(host);
	runSshSync(["-O", "exit", ...buildCommonArgs(host), target]);
}

export async function closeConnection(hostName: string): Promise<void> {
	const host = activeHosts.get(hostName);
	if (!host) {
		closeConnectionInternal({ name: hostName, host: hostName });
		return;
	}
	closeConnectionInternal(host);
	activeHosts.delete(hostName);
}

export async function closeAllConnections(): Promise<void> {
	for (const [name, host] of Array.from(activeHosts.entries())) {
		closeConnectionInternal(host);
		activeHosts.delete(name);
	}
}

export function getControlPathTemplate(): string {
	return CONTROL_PATH;
}

export function getControlDir(): string {
	return CONTROL_DIR;
}
