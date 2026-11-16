import * as fs from "node:fs";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { getAgentDir, getProjectDir, MAIN_CONFIG_FILENAMES } from "./dirs";
import { $env, filterChildShellEnv } from "./env";
import { isExecutable } from "./executable";
import { $which } from "./which";

export { isExecutable };
export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}

/** Identifies the settings source users should edit when shell resolution fails. */
export interface ShellConfigOptions {
	/** File path or runtime layer that supplied the active shell setting. */
	configSource?: string;
}
/** Auto-resolved shell (no custom path); kept until {@link refreshShellConfigCache}. */
let cachedDefaultShellConfig: ShellConfig | null = null;
/** Config for the most recent custom `shellPath`; never served once the path is cleared. */
let cachedCustomShellConfig: ShellConfig | null = null;
/**
 * The child-shell environment {@link refreshShellConfigCache} last captured. Unset
 * until the first refresh, so spawn environments are built from the live environment.
 */
let capturedChildShellEnv: Record<string, string> | undefined;
/**
 * Project whose dotenv values the spawn environment filters out: the one current
 * when it was first built or captured.
 * That is normally the launch project, whose dotenv files Bun and omp load into
 * `process.env`; a later session in another project must not receive them.
 */
let spawnEnvProjectDir: string | undefined;

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
	spawnEnvProjectDir ??= getProjectDir();
	return {
		...(capturedChildShellEnv ?? filterChildShellEnv(Bun.env, spawnEnvProjectDir)),
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

/**
 * Get shell args for the resolved shell.
 * POSIX shells take `-c`, with `-l` unless PI_BASH_NO_LOGIN /
 * CLAUDE_BASH_NO_LOGIN is set.
 *
 * Exported for tests; `env` overrides the process env gate.
 */
export function getShellArgs(env: Record<string, string | undefined> = $env): string[] {
	const noLogin = env.PI_BASH_NO_LOGIN || env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

const POSIX_SHELL_PATTERN = /(?:^|\/)(?:sh|bash|dash|ash|ksh|zsh)$/i;

/** Whether the executable is a known shell whose command language uses POSIX quoting. */
export function isPosixShell(shell: string): boolean {
	return POSIX_SHELL_PATTERN.test(shell);
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
	return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "sh"]) {
		const resolved = $which(name);
		if (resolved) return resolved;
	}

	const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
	for (const name of ["bash", "sh"]) {
		for (const dir of searchPaths) {
			const fullPath = path.join(dir, name);
			if (fs.existsSync(fullPath)) return fullPath;
		}
	}

	return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath from the active settings source
 * 2. $SHELL if bash/zsh, then fallback paths
 * 3. Fallback: sh
 *
 * Custom and auto-resolved configs are cached separately, so clearing
 * `shellPath` mid-process immediately falls back to the platform default.
 */
export function getShellConfig(customShellPath?: string, options: ShellConfigOptions = {}): ShellConfig {
	const configSource = options.configSource ?? path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
	// 1. Check user-specified shell path. Validated even on the cached path so a
	// broken shellPath surfaces its guidance error instead of being masked by an
	// earlier successful resolution in the same process.
	if (customShellPath) {
		if (!fs.existsSync(customShellPath)) {
			throw new Error(`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${configSource}`);
		}
		if (cachedCustomShellConfig?.shell !== customShellPath) {
			cachedCustomShellConfig = buildConfig(customShellPath);
		}
		return cachedCustomShellConfig;
	}
	cachedDefaultShellConfig ??= buildConfig(resolveDefaultShell());
	return cachedDefaultShellConfig;
}

/**
 * Capture the current process environment for child shells and drop both cached
 * shell configs, so the next {@link getShellConfig} builds the spawn environment
 * from that capture. Call right after code that changed `process.env` in a way
 * child shells must see, such as extension session lifecycle handlers exporting
 * session-scoped variables; later writes reach child shells only at the next call.
 */
export function refreshShellConfigCache(): void {
	spawnEnvProjectDir ??= getProjectDir();
	capturedChildShellEnv = filterChildShellEnv(Bun.env, spawnEnvProjectDir);
	cachedDefaultShellConfig = null;
	cachedCustomShellConfig = null;
}

/**
 * Test-only: forget the capture and both cached shell configs, so the next
 * {@link getShellConfig} builds from the live environment again. Production code
 * MUST NOT call this; the capture's lifecycle is owned by {@link refreshShellConfigCache}.
 */
export function __resetShellConfigCacheForTests(): void {
	capturedChildShellEnv = undefined;
	spawnEnvProjectDir = undefined;
	cachedDefaultShellConfig = null;
	cachedCustomShellConfig = null;
}

/** Shell discovery used when no custom `shellPath` is configured. */
function resolveDefaultShell(): string {
	// Prefer user's shell from $SHELL if it's bash/zsh and executable
	const userShell = Bun.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		return userShell;
	}

	// Fallback: use basic shell
	return resolveBasicShell() ?? "sh";
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	return (await Process.fromPid(proc)?.waitForExit({ signal: abortSignal })) ?? true;
}
