import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { getProviderInFlightRoot, isEnoent, isPidAlive, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { createAuthRetryKeyState, isApiKeyResolver, resolvedApiKeyBearer, resolveNextAuthRetryKey } from "./auth-retry";
import * as AIError from "./error";
import { streamOpenAICompletions } from "./providers/openai-completions";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	StreamOptions,
} from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { withThinkingLoopGuard } from "./utils/thinking-loop";
type ProviderInFlightLease = {
	path: string;
	stopHeartbeat: () => Promise<void>;
};

type ProviderInFlightLeaseInfo = {
	pid: number;
	timestamp: number;
	token: string;
};
type ProviderInFlightStaleLock = { token: string } | { mtimeMs: number };
type ProviderInFlightLockIdentity = { dev: number; ino: number; birthtimeMs: number };

const PROVIDER_INFLIGHT_LOCK_STALE_MS = 10_000;
const PROVIDER_INFLIGHT_LEASE_STALE_MS = 30_000;
const PROVIDER_INFLIGHT_HEARTBEAT_MS = 5_000;
const PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS = 250;
const PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS = 1_000;
const PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS = 5_000;
const PROVIDER_INFLIGHT_LOCK_RETRY_INITIAL_MS = 25;
const PROVIDER_INFLIGHT_LOCK_RETRY_MAX_MS = 250;
const PROVIDER_INFLIGHT_LOCK_RETRY_BUDGET_MS = 3_000;

let configuredProviderMaxInFlightRequests: Record<string, number> = {};
let providerInFlightRootOverride: string | undefined;
let providerInFlightHeartbeatMsOverride: number | undefined;
let providerInFlightHeartbeatFlushTimeoutMsOverride: number | undefined;
let providerInFlightHeartbeatWriterOverride:
	| ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>)
	| undefined;
let providerInFlightLeaseRemoverOverride: ((leasePath: string) => Promise<void>) | undefined;
let providerInFlightWaitObserverOverride: ((provider: string) => void) | undefined;
let providerInFlightLockCreatedObserverOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockIdentifiedObserverOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockMkdirOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockPlatformOverride: NodeJS.Platform | undefined;
let providerInFlightLockRetryTimings: { budgetMs?: number; initialDelayMs?: number; maxDelayMs?: number } | undefined;

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredProviderMaxInFlightRequests = limits ?? {};
}

function resolveProviderInFlightLimit(
	provider: string,
	options?: Pick<StreamOptions, "maxInFlightRequests">,
): number | undefined {
	const limits = options?.maxInFlightRequests ?? configuredProviderMaxInFlightRequests;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}

function providerInFlightRoot(): string {
	if (providerInFlightRootOverride) return providerInFlightRootOverride;
	return getProviderInFlightRoot();
}

function providerInFlightSegment(provider: string): string {
	return Bun.SHA256.hash(provider, "base64url");
}

function providerInFlightDir(provider: string): string {
	return path.join(providerInFlightRoot(), providerInFlightSegment(provider));
}

function providerInFlightSignalPath(provider: string): string {
	return path.join(providerInFlightDir(provider), ".wakeup");
}

function providerInFlightLockDir(provider: string): string {
	return `${providerInFlightDir(provider)}.lock`;
}

async function readProviderInFlightInfo(infoPath: string): Promise<ProviderInFlightLeaseInfo | null> {
	try {
		const content = await fs.readFile(infoPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<ProviderInFlightLeaseInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number" || typeof parsed.token !== "string") {
			return null;
		}
		return { pid: parsed.pid, timestamp: parsed.timestamp, token: parsed.token };
	} catch {
		return null;
	}
}

async function writeProviderInFlightInfo(dir: string, token: string): Promise<void> {
	const info: ProviderInFlightLeaseInfo = { pid: process.pid, timestamp: Date.now(), token };
	const infoPath = path.join(dir, "info.json");
	const tempPath = path.join(dir, `.info-${process.pid}-${crypto.randomUUID()}.tmp`);
	try {
		// Unlike Bun.write, fs.writeFile does not recreate a lease directory that
		// was removed while a timed-out heartbeat was still pending.
		await fs.writeFile(tempPath, JSON.stringify(info), "utf8");
		await fs.rename(tempPath, infoPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function isProviderInFlightDirStale(dir: string, staleMs: number): Promise<boolean> {
	const info = await readProviderInFlightInfo(path.join(dir, "info.json"));
	if (info) {
		if (!isPidAlive(info.pid)) return true;
		return Date.now() - info.timestamp > staleMs;
	}

	try {
		const stat = await fs.stat(path.join(dir, "info.json"));
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	try {
		const stat = await fs.stat(dir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readProviderInFlightStaleLock(lockDir: string): Promise<ProviderInFlightStaleLock | null> {
	const infoPath = path.join(lockDir, "info.json");
	const info = await readProviderInFlightInfo(infoPath);
	if (info) return isPidAlive(info.pid) ? null : { token: info.token };

	try {
		const stat = await fs.stat(lockDir);
		return Date.now() - stat.mtimeMs > PROVIDER_INFLIGHT_LOCK_STALE_MS ? { mtimeMs: stat.mtimeMs } : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readProviderInFlightLockIdentity(lockDir: string): Promise<ProviderInFlightLockIdentity> {
	const stat = await fs.stat(lockDir);
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function isSameProviderInFlightLock(
	current: ProviderInFlightLockIdentity,
	expected: ProviderInFlightLockIdentity,
): boolean {
	if (current.dev !== expected.dev) return false;
	if (current.ino !== 0 || expected.ino !== 0) return current.ino === expected.ino;
	return current.birthtimeMs === expected.birthtimeMs;
}

async function releaseProviderInFlightStaleLock(lockDir: string, stale: ProviderInFlightStaleLock): Promise<void> {
	if ("token" in stale) {
		await releaseProviderInFlightLock(lockDir, stale.token);
		return;
	}

	const infoPath = path.join(lockDir, "info.json");
	if (await readProviderInFlightInfo(infoPath)) return;
	try {
		const stat = await fs.stat(lockDir);
		if (stat.mtimeMs !== stale.mtimeMs || Date.now() - stat.mtimeMs <= PROVIDER_INFLIGHT_LOCK_STALE_MS) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

// Best-effort token-checked release. A token mismatch means another process has
// already replaced the lock, so the fresh lock must be left intact.
async function releaseProviderInFlightLock(lockDir: string, token: string): Promise<void> {
	try {
		const info = await readProviderInFlightInfo(path.join(lockDir, "info.json"));
		if (!info || info.token !== token) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function releaseProviderInFlightLockDirIfSame(
	lockDir: string,
	identity: ProviderInFlightLockIdentity,
): Promise<void> {
	try {
		if (await readProviderInFlightInfo(path.join(lockDir, "info.json"))) return;
		const current = await readProviderInFlightLockIdentity(lockDir);
		if (!isSameProviderInFlightLock(current, identity)) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

// On Windows, mkdir on a lock directory another process is concurrently deleting
// (delete-pending while a watcher, antivirus, or indexer still holds it) fails
// with ERROR_ACCESS_DENIED — mapped to EPERM/EACCES — instead of EEXIST, so
// ordinary contention looks like a permission error. On win32 only, back off and
// retry briefly; if the failure persists past the budget, rethrow the original
// error so a real permission problem still surfaces. Every other outcome
// (success, EEXIST, any other code) exits immediately, keeping non-win32 and
// non-transient behavior unchanged.
function isTransientProviderInFlightLockMkdirError(error: NodeJS.ErrnoException): boolean {
	if ((providerInFlightLockPlatformOverride ?? process.platform) !== "win32") return false;
	return error.code === "EPERM" || error.code === "EACCES";
}

async function mkdirProviderInFlightLockDir(lockDir: string, signal?: AbortSignal): Promise<void> {
	const mkdir = providerInFlightLockMkdirOverride ?? ((dir: string) => fs.mkdir(dir));
	let failures = 0;
	let since = Date.now();
	while (true) {
		try {
			await mkdir(lockDir);
			return;
		} catch (error) {
			if (!isTransientProviderInFlightLockMkdirError(error as NodeJS.ErrnoException)) throw error;
			const now = Date.now();
			if (failures === 0) since = now;
			const budgetMs = providerInFlightLockRetryTimings?.budgetMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_BUDGET_MS;
			if (now - since >= budgetMs) throw error;
			const initialMs = providerInFlightLockRetryTimings?.initialDelayMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_INITIAL_MS;
			const maxMs = providerInFlightLockRetryTimings?.maxDelayMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_MAX_MS;
			const delayMs = Math.min(maxMs, initialMs * 2 ** failures);
			failures++;
			await untilAborted(signal, Bun.sleep(delayMs));
		}
	}
}

async function acquireProviderInFlightLock(provider: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lockDir = providerInFlightLockDir(provider);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		try {
			await mkdirProviderInFlightLockDir(lockDir, signal);
			await providerInFlightLockCreatedObserverOverride?.(lockDir);
			let lockIdentity: ProviderInFlightLockIdentity;
			try {
				lockIdentity = await readProviderInFlightLockIdentity(lockDir);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const token = crypto.randomUUID();
			try {
				await providerInFlightLockIdentifiedObserverOverride?.(lockDir);
				await writeProviderInFlightInfo(lockDir, token);
			} catch (error) {
				await releaseProviderInFlightLockDirIfSame(lockDir, lockIdentity);
				if (isEnoent(error)) continue;
				throw error;
			}
			return async () => {
				await releaseProviderInFlightLock(lockDir, token);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const staleLock = await readProviderInFlightStaleLock(lockDir);
		if (staleLock) {
			await releaseProviderInFlightStaleLock(lockDir, staleLock);
			await signalProviderInFlightWaiters(provider);
			continue;
		}

		await waitForProviderInFlightSignal(provider, signal);
	}
}

async function cleanupProviderInFlightLeases(providerDir: string): Promise<number> {
	let active = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(providerDir);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	for (const entry of entries) {
		const leaseDir = path.join(providerDir, entry);
		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(leaseDir)).isDirectory();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isDirectory) continue;
		if (await isProviderInFlightDirStale(leaseDir, PROVIDER_INFLIGHT_LEASE_STALE_MS)) {
			await fs.rm(leaseDir, { recursive: true, force: true });
			continue;
		}
		active++;
	}
	return active;
}

async function tryAcquireProviderInFlightLease(
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<ProviderInFlightLease | null> {
	const releaseLock = await acquireProviderInFlightLock(provider, signal);
	try {
		const dir = providerInFlightDir(provider);
		await fs.mkdir(dir, { recursive: true });
		const active = await cleanupProviderInFlightLeases(dir);
		if (active >= limit) return null;

		const leaseDir = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
		const token = crypto.randomUUID();
		try {
			await fs.mkdir(leaseDir);
			await writeProviderInFlightInfo(leaseDir, token);
		} catch (error) {
			await removeProviderInFlightLeaseDir(leaseDir).catch(() => {});
			throw error;
		}
		let heartbeatActive = true;
		let heartbeatFlush = Promise.resolve();
		const touchHeartbeat = () => {
			if (!heartbeatActive) return;
			heartbeatFlush = heartbeatFlush
				.then(async () => {
					if (!heartbeatActive) return;
					const write = () => {
						if (!heartbeatActive) return Promise.resolve();
						return writeProviderInFlightInfo(leaseDir, token);
					};
					if (providerInFlightHeartbeatWriterOverride) {
						await providerInFlightHeartbeatWriterOverride(write);
					} else {
						await write();
					}
				})
				.catch(() => {});
		};
		const heartbeat = setInterval(
			touchHeartbeat,
			providerInFlightHeartbeatMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_MS,
		);
		heartbeat.unref?.();
		return {
			path: leaseDir,
			stopHeartbeat: () => {
				heartbeatActive = false;
				clearInterval(heartbeat);
				return heartbeatFlush;
			},
		};
	} finally {
		await releaseLock();
	}
}

async function signalProviderInFlightWaitersInDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, ".wakeup"), String(Date.now()));
	} catch {}
}

async function signalProviderInFlightWaiters(provider: string): Promise<void> {
	await signalProviderInFlightWaitersInDir(providerInFlightDir(provider));
}

function waitForProviderInFlightSignal(provider: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch"));
	const signalPath = providerInFlightSignalPath(provider);
	providerInFlightWaitObserverOverride?.(provider);
	const waitStarted = Date.now();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let watcher: fsSync.FSWatcher | undefined;
	const timer = setTimeout(() => finish(resolve), PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS);
	const finish = (settle: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		watcher?.close();
		signal?.removeEventListener("abort", onAbort);
		settle();
	};
	const onAbort = () => {
		finish(() => reject(signal?.reason ?? new AIError.AbortError("Provider request aborted before dispatch")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		watcher = fsSync.watch(providerInFlightDir(provider), (_event, filename) => {
			if (filename === ".wakeup" || filename === null) {
				finish(resolve);
			}
		});
		void fs.stat(signalPath).then(
			stat => {
				if (stat.mtimeMs >= waitStarted) finish(resolve);
			},
			error => {
				if (!isEnoent(error)) finish(resolve);
			},
		);
	} catch {
		// Filesystem notifications are best-effort across platforms; the fallback
		// timer keeps stale-lock/lease cleanup progressing if an event is dropped.
	}
	return promise;
}

async function removeProviderInFlightLeaseDir(leasePath: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rm(leasePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (isEnoent(error)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				await Bun.sleep(25);
				continue;
			}
			throw error;
		}
	}
}

// Signal into the lease's OWN provider directory (derived from `lease.path`)
// rather than recomputing it from the current root. A release that lands after
// the in-flight root has been repointed (only the test seam does that) must not
// write `.wakeup` into an unrelated provider directory.
async function releaseProviderInFlightLease(lease: ProviderInFlightLease): Promise<void> {
	const heartbeatFlush = lease.stopHeartbeat();
	const flushTimeout = Promise.withResolvers<"timeout">();
	const flushTimer = setTimeout(
		() => flushTimeout.resolve("timeout"),
		providerInFlightHeartbeatFlushTimeoutMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS,
	);
	flushTimer.unref?.();
	try {
		const outcome = await Promise.race([heartbeatFlush.then(() => "flushed" as const), flushTimeout.promise]);
		if (outcome === "timeout") {
			logger.warn("Provider in-flight heartbeat flush timed out; forcing lease cleanup", { path: lease.path });
		}
	} finally {
		clearTimeout(flushTimer);
	}

	const releaseTimeout = Promise.withResolvers<never>();
	const releaseTimer = setTimeout(
		() => releaseTimeout.reject(new Error("Provider in-flight lease cleanup timed out")),
		PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS,
	);
	releaseTimer.unref?.();
	try {
		const removeLease = providerInFlightLeaseRemoverOverride ?? removeProviderInFlightLeaseDir;
		await Promise.race([removeLease(lease.path), releaseTimeout.promise]);
	} finally {
		clearTimeout(releaseTimer);
	}
	// Wake-up is an optimization: waiters also poll every 250 ms. Do not let a
	// notification-file stall keep a completed provider request open.
	void signalProviderInFlightWaitersInDir(path.dirname(lease.path));
}

async function acquireProviderInFlightSlot(
	provider: string,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (limit === undefined) return async () => {};
	let loggedWait = false;
	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		const lease = await tryAcquireProviderInFlightLease(provider, limit, signal);
		if (lease) return () => releaseProviderInFlightLease(lease);
		if (!loggedWait) {
			loggedWait = true;
			logger.debug("Provider in-flight limit blocked request", { provider, limit });
		}
		await waitForProviderInFlightSignal(provider, signal);
	}
}

export const __providerInFlightForTesting = {
	setRoot(root: string | undefined): void {
		providerInFlightRootOverride = root;
	},
	setHeartbeatTimings(timings: { heartbeatMs?: number; heartbeatFlushTimeoutMs?: number } | undefined): void {
		providerInFlightHeartbeatMsOverride = timings?.heartbeatMs;
		providerInFlightHeartbeatFlushTimeoutMsOverride = timings?.heartbeatFlushTimeoutMs;
	},
	setHeartbeatWriter(writer: ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>) | undefined): void {
		providerInFlightHeartbeatWriterOverride = writer;
	},
	setLeaseRemover(remover: ((leasePath: string) => Promise<void>) | undefined): void {
		providerInFlightLeaseRemoverOverride = remover;
	},
	setWaitObserver(observer: ((provider: string) => void) | undefined): void {
		providerInFlightWaitObserverOverride = observer;
	},
	setLockCreatedObserver(observer: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockCreatedObserverOverride = observer;
	},
	setLockIdentifiedObserver(observer: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockIdentifiedObserverOverride = observer;
	},
	setLockMkdirOverride(mkdir: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockMkdirOverride = mkdir;
	},
	setLockPlatformOverride(platform: NodeJS.Platform | undefined): void {
		providerInFlightLockPlatformOverride = platform;
	},
	setLockRetryTimings(timings: { budgetMs?: number; initialDelayMs?: number; maxDelayMs?: number } | undefined): void {
		providerInFlightLockRetryTimings = timings;
	},
	providerDir(provider: string): string {
		return providerInFlightDir(provider);
	},
	lockDir(provider: string): string {
		return providerInFlightLockDir(provider);
	},
	async captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		const stale = await readProviderInFlightStaleLock(lockDir);
		if (!stale) return null;
		return () => releaseProviderInFlightStaleLock(lockDir, stale);
	},
	async captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		try {
			const identity = await readProviderInFlightLockIdentity(lockDir);
			return () => releaseProviderInFlightLockDirIfSame(lockDir, identity);
		} catch {
			return null;
		}
	},
};

function withProviderInFlightLimit<
	TOptions extends Pick<StreamOptions, "signal" | "maxInFlightRequests" | "beforeDispatch">,
>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: (limited: boolean) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	// Leaked-thinking healing folds in here — the one shared provider-dispatch
	// chokepoint — so the loop guard (which wraps this) sees healed events and all
	// provider exits are covered by one wrap. Official first-party providers are
	// exempt (see `healLeakedThinking`); healing is otherwise idempotent.
	const limit = resolveProviderInFlightLimit(model.provider, options);
	if (limit === undefined) {
		return dispatch(false);
	}

	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		let releasePromise: Promise<void> | undefined;
		const releaseOnce = () => {
			if (!release) return Promise.resolve();
			releasePromise ??= release();
			return releasePromise;
		};
		const releaseBestEffort = async () => {
			try {
				await releaseOnce();
			} catch (releaseError) {
				// The lease has stopped heartbeating and stale cleanup will reap it
				// within PROVIDER_INFLIGHT_LEASE_STALE_MS. Until then, its slot may
				// remain unavailable and waiters rely on the fallback poll.
				// Never replace a completed response or the provider's original error
				// with a coordination-directory cleanup failure.
				logger.warn("Provider in-flight permit release failed", {
					provider: model.provider,
					error: String(releaseError),
				});
			}
		};
		try {
			const startedWaitingAt = Date.now();
			release = await acquireProviderInFlightSlot(model.provider, limit, options?.signal);
			if (Date.now() - startedWaitingAt >= PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS) {
				logger.debug("Provider in-flight limit wait completed", { provider: model.provider, limit });
			}
			if (options?.signal?.aborted) {
				throw options.signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
			}
			const inner = dispatch(true);
			let terminalEvent: AssistantMessageEvent | undefined;
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					terminalEvent = event;
					break;
				}
				outer.push(event);
				if (outer.done) {
					await releaseBestEffort();
					return;
				}
			}
			const result = await inner.result();
			// Releasing the permit is part of request completion. Publishing the
			// result first lets an immediate follow-up turn contend with its own
			// still-live lease, which is particularly costly on Windows.
			await releaseBestEffort();
			if (!outer.done) {
				if (terminalEvent) outer.push(terminalEvent);
				else outer.end(result);
			}
		} catch (error) {
			await releaseBestEffort();
			if (!outer.done) outer.fail(error);
		}
	})();
	return outer;
}

function assertChatApi(model: Model<Api>): asserts model is Model<"openai-completions"> {
	if (model.api !== "openai-completions")
		throw new AIError.ConfigurationError(`Unsupported API: ${model.api}. Only openai-completions is supported.`);
}
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	assertChatApi(model);
	return withThinkingLoopGuard(model, options, guarded =>
		withProviderInFlightLimit(model, guarded, limited =>
			streamOpenAICompletions(model, context, { ...guarded, waitForTerminalDrain: limited }),
		),
	);
}
function withInferenceSessionId(options?: SimpleStreamOptions): SimpleStreamOptions {
	return options?.sessionId ? options : { ...options, sessionId: crypto.randomUUID() };
}
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	assertChatApi(model);
	const request = withInferenceSessionId(options);
	if (!isApiKeyResolver(request.apiKey)) return stream(model, context, { ...request, apiKey: request.apiKey });
	const resolver = request.apiKey;
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			request.signal?.throwIfAborted();
			let resolved = await resolver({ error: undefined, lastChance: false, signal: request.signal });
			let key = resolvedApiKeyBearer(resolved);
			const state = key === undefined ? undefined : createAuthRetryKeyState(key);
			for (;;) {
				const credentialId = typeof resolved === "object" ? resolved.credentialId : undefined;
				const inner = stream(model, context, { ...request, apiKey: key, credentialId });
				const buffered: AssistantMessageEvent[] = [];
				let exposed = false;
				let retryError: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
				for await (const event of inner) {
					if (!exposed && event.type === "start") {
						buffered.push(event);
						continue;
					}
					if (
						!exposed &&
						event.type === "error" &&
						(event.error.errorStatus === 401 || event.error.errorStatus === 403)
					) {
						retryError = event;
						break;
					}
					for (const start of buffered.splice(0)) outer.push(start);
					outer.push(event);
					exposed = true;
				}
				if (!retryError || !state) {
					for (const start of buffered) outer.push(start);
					if (retryError) outer.push(retryError);
					outer.end(await inner.result());
					return;
				}
				const failure = new AIError.ProviderHttpError(
					retryError.error.errorMessage ?? "Authentication failed",
					retryError.error.errorStatus!,
				);
				const next = await resolveNextAuthRetryKey(state, resolver, failure, request.signal, value => {
					resolved = value;
				});
				if (next === undefined) {
					for (const start of buffered) outer.push(start);
					outer.push(retryError);
					outer.end();
					return;
				}
				key = next;
			}
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}
/** Maximum guarded attempts for a detected thinking loop. */
const THINKING_LOOP_MAX_ATTEMPTS = 3;
const THINKING_LOOP_RETRY_BASE_DELAY_MS = 500;
const THINKING_LOOP_RETRY_MAX_DELAY_MS = 8_000;

function isRetryableThinkingLoop(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		message.content.length === 0 &&
		AIError.is(message.errorId, AIError.Flag.ThinkingLoop)
	);
}

/**
 * Resolve a completion, re-sampling a thinking-loop stall for at most
 * {@link THINKING_LOOP_MAX_ATTEMPTS} guarded attempts. The loop guard raises an
 * empty `stopReason: "error"` stall; after the budget is spent that error is
 * returned unchanged. Detection is never disabled as a fallback, because an
 * unguarded retry can consume the remaining output budget and persist runaway
 * content. Non-stall results, including genuine errors, return immediately. A
 * caller abort during backoff propagates so cancellation surfaces as an abort,
 * never a stale stall result.
 */
async function resolveWithThinkingLoopRetries(
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
	onAttempt?: (message: AssistantMessage) => void,
): Promise<AssistantMessage> {
	const dispatchAttempt = async (): Promise<AssistantMessage> => {
		const response = dispatch();
		for await (const _event of response) {
			// Completion callers do not consume deltas; drain them as they arrive to avoid retaining the response history.
		}
		const message = await response.result();
		onAttempt?.(message);
		return message;
	};
	let message = await dispatchAttempt();
	let thinkingLoopRetry = isRetryableThinkingLoop(message);
	for (let attempt = 1; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ATTEMPTS; attempt += 1) {
		// A caller abort surfaces as a thrown abort (never the stall, which would
		// misclassify as a 502): throwIfAborted before backoff, and scheduler.wait
		// rejects if the abort lands mid-delay.
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		message = await dispatchAttempt();
		thinkingLoopRetry = isRetryableThinkingLoop(message);
	}
	if (thinkingLoopRetry) signal?.throwIfAborted();
	return message;
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => stream(model, context, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions & {
		/** Receives every completed result, including results retried by the thinking-loop guard. */
		onAttempt?: (message: AssistantMessage) => void;
	},
): Promise<AssistantMessage> {
	const { onAttempt, ...streamOptions } = options ?? {};
	const sessionOptions = withInferenceSessionId(streamOptions);
	return resolveWithThinkingLoopRetries(
		options?.signal,
		() => streamSimple(model, context, sessionOptions),
		onAttempt,
	);
}
