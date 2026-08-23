/**
 * Bounded runtime-availability probe shared by the Python/Ruby/Julia eval
 * backends.
 *
 * Each per-language `checkXKernelAvailability` helper runs a tiny "does this
 * interpreter start" command (`python -c "import sys;sys.exit(0)"` and friends)
 * during `resolveBackend()` — before the eval cell's `IdleTimeout` is armed.
 * Two footguns let that probe wedge an entire agent turn (issue #9466):
 *
 *   1. Bun's `$` shell inherits the host stdin handle. On native Windows an
 *      inherited RPC/console stdin handle keeps the probe subprocess alive
 *      indefinitely even though the script never reads stdin.
 *   2. The probe had no timeout and honored no AbortSignal, so nothing bounded
 *      a hung interpreter and the documented eval timeout — armed only later —
 *      could never cancel it.
 *
 * {@link runBoundedProbe} spawns with stdin/stdout/stderr detached, enforces a
 * wall-clock timeout, and honors an optional AbortSignal so a turn abort tears
 * the probe down instead of leaking the subprocess.
 */

/** Wall-clock ceiling for a runtime-availability probe when no smaller bound is supplied. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Cancellation controls threaded from the eval tool through
 * `resolveBackend` → `ExecutorBackend.isAvailable` → `checkXKernelAvailability`
 * so backend discovery is bounded by the same timeout and turn abort as the
 * eval cell that triggered it.
 */
export interface BackendProbeOptions {
	/** Aborts the probe when the parent turn is cancelled. */
	signal?: AbortSignal;
	/** Wall-clock ceiling in ms; clamped to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Outcome of a single bounded probe spawn. */
export interface BoundedProbeResult {
	/** Process exit code, or `null` when killed by timeout/abort. */
	exitCode: number | null;
	/** The probe exceeded its wall-clock bound and was killed. */
	timedOut: boolean;
	/** The probe was killed via the supplied AbortSignal. */
	aborted: boolean;
}

export interface BoundedProbeSpawnOptions extends BackendProbeOptions {
	cwd: string;
	env: Record<string, string | undefined>;
}

/**
 * Spawn `command` detached from the host's stdio, bounded by a timeout and an
 * optional AbortSignal. Never inherits stdin (the Windows wedge in #9466) and
 * always resolves — a hung interpreter yields `{ timedOut: true, exitCode: null }`
 * rather than an unsettled promise.
 *
 * Throws only when the spawn itself fails (e.g. ENOENT); callers already treat
 * that as an unavailable candidate.
 */
export async function runBoundedProbe(
	command: string[],
	{ cwd, env, signal, timeoutMs }: BoundedProbeSpawnOptions,
): Promise<BoundedProbeResult> {
	if (signal?.aborted) {
		return { exitCode: null, timedOut: false, aborted: true };
	}
	const bound = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
	});
	let timedOut = false;
	let aborted = false;
	const kill = (): void => {
		try {
			proc.kill();
		} catch {
			// Already exited; nothing to reap.
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, bound);
	const onAbort = (): void => {
		aborted = true;
		kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const exitCode = await proc.exited;
		return { exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
