/**
 * Process-wide registry of open IDA databases.
 *
 * Each database runs in its own long-lived Python worker (`worker.py`) because idalib
 * supports one kernel and one open database per process. Every agent, subagent, and
 * post-compaction turn in this omp process shares the same live worker; requests to a
 * worker are serialized. Databases are saved on close and on process exit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, logger, postmortem, readLines, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Subprocess } from "bun";
import { killProcessGroup } from "../eval/kernel-base";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "../eval/py/spawn-options";
import { stageRunnerScript } from "../eval/runner-cache";
import type { ToolSession } from "../tools";
import { type IdaRuntime, resolveIdaRuntime } from "./runtime";
import { cfgIdaIdleCloseSec, cfgIdaMaxOpen } from "./settings";
import {
	type FatSelection,
	type IdbLocation,
	type LocateIdbOptions,
	locateIdb,
	prepareStoreDir,
	SLICE_SEPARATOR,
	sanitizeIdbName,
} from "./store";
import IDA_WORKER from "./worker.py" with { type: "text" };

/** How long a worker gets to answer after SIGINT before it is killed. */
const INTERRUPT_GRACE_MS = 5_000;
/** Budget for the worker's `close` (including the final save). */
const CLOSE_TIMEOUT_MS = 120_000;
/** How long a dirty database must sit idle before it is saved automatically. */
const AUTOSAVE_IDLE_MS = 10_000;
/** How long to wait for the worker to exit after answering `close`. */
const EXIT_GRACE_MS = 10_000;
/** How long the exit handler waits for stdout/stderr to drain before failing pending requests. */
const STREAM_DRAIN_MS = 1_000;
const STDERR_TAIL_CHARS = 64 * 1024;
const STDERR_TAIL_LINES = 20;

/** RPC methods implemented by the IDA worker. */
export type IdaMethod =
	| "open"
	| "view"
	| "exec"
	| "rename"
	| "comment"
	| "set_type"
	| "make_function"
	| "save"
	| "close";

/** Loader facts the worker reports when a database opens. */
export interface IdaDatabaseInfo {
	module: string;
	format: string;
	arch: string;
	bitness: number;
}

/** Per-request cancellation and deadline; either one interrupts the worker (SIGINT, then SIGKILL). */
export interface IdaRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface IdaOpenResult extends IdaDatabaseInfo {
	idb: string;
}

/** The request a worker is currently executing. */
export interface IdaRunningRequest {
	method: IdaMethod;
	startedAt: number;
}

type WorkerResponse =
	| { id: number; ok: true; result: unknown; dirty?: boolean }
	| { id: number; ok: false; message: string };

type RequestOutcome = { kind: "response"; value: unknown } | { kind: "interrupted" };

const databases = new Map<string, IdaDatabase>();
const pending = new Map<string, Promise<IdaDatabase>>();
let cleanupRegistered = false;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A timer that does not keep the event loop alive; `cancel` clears it. */
function delay(ms: number): { promise: Promise<void>; cancel(): void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return { promise, cancel: () => clearTimeout(timer) };
}

function parseWorkerResponse(frame: unknown): WorkerResponse | null {
	if (typeof frame !== "object" || frame === null) return null;
	if (!("id" in frame) || typeof frame.id !== "number") return null;
	if (!("ok" in frame) || typeof frame.ok !== "boolean") return null;
	if (frame.ok) {
		const result = "result" in frame ? frame.result : undefined;
		const dirty = "dirty" in frame && typeof frame.dirty === "boolean" ? frame.dirty : undefined;
		return { id: frame.id, ok: true, result, dirty };
	}
	const error = "error" in frame ? frame.error : undefined;
	const message =
		typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: "IDA worker request failed";
	return { id: frame.id, ok: false, message };
}

/** A live IDA database backed by a dedicated worker process; shared by every agent in this omp process. */
export class IdaDatabase {
	/** Registry key from `locateIdb`. */
	readonly id: string;
	/** Absolute path of the binary or `.i64`/`.idb` the database was opened for. */
	readonly sourcePath: string;
	/** For universal binaries: the analyzed slice and its siblings. */
	readonly fat?: FatSelection;
	/** Worker process id. */
	readonly pid: number;
	#idbPath: string;
	#info: IdaDatabaseInfo = { module: "", format: "", arch: "", bitness: 0 };
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	readonly #lock: FileLockHandle;
	readonly #streamsDrained: Promise<unknown>;
	#queue: Promise<void> = Promise.resolve();
	#pending = new Map<number, PromiseWithResolvers<unknown>>();
	#nextId = 1;
	#stderrTail = "";
	#exitCode: number | null = null;
	/** Set once `open` succeeded; from then on the worker's exit releases the lock. */
	#opened = false;
	#closing: Promise<void> | null = null;
	/** Whether the worker reported unsaved changes in its last successful response. */
	#dirty = false;
	/** Requests queued or in flight. */
	#active = 0;
	#current: IdaRunningRequest | null = null;
	#lastUsed = Date.now();
	/** Idle time after which the database is saved and closed; 0 disables. */
	readonly #idleCloseMs: number;
	#autosaveTimer: Timer | undefined;
	#idleTimer: Timer | undefined;

	private constructor(
		loc: IdbLocation,
		proc: Subprocess<"pipe", "pipe", "pipe">,
		lock: FileLockHandle,
		idleCloseMs: number,
	) {
		this.id = loc.id;
		this.sourcePath = loc.sourcePath;
		this.fat = loc.fat;
		this.pid = proc.pid;
		this.#idbPath = loc.openPath;
		this.#proc = proc;
		this.#lock = lock;
		this.#idleCloseMs = idleCloseMs;
		this.#streamsDrained = Promise.all([this.#readStdout(proc.stdout), this.#drainStderr(proc.stderr)]);
		void proc.exited.then(code => this.#onExit(code));
	}

	/**
	 * Spawn a worker for `loc` and open its database. The caller holds `lock` and has run
	 * `prepareStoreDir`; on failure the worker is killed, a half-created store IDB is removed,
	 * and the lock stays with the caller. The open cannot be cancelled: idalib ignores SIGINT
	 * while opening, so an interrupt would kill the worker mid-creation.
	 */
	static async start(
		loc: IdbLocation,
		runtime: IdaRuntime,
		lock: FileLockHandle,
		idleCloseMs: number,
	): Promise<IdaDatabase> {
		const script = await stageRunnerScript("omp-ida-worker", "py", IDA_WORKER);
		const proc = Bun.spawn([runtime.pythonPath, "-u", script], {
			cwd: loc.dir,
			env: runtime.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: shouldDetachKernel(process.platform),
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});
		const db = new IdaDatabase(loc, proc, lock, idleCloseMs);
		try {
			const opened = await db.request<IdaOpenResult>("open", { path: loc.openPath, new: loc.isNew });
			if (db.#exitCode !== null) throw db.#exitError();
			db.#idbPath = opened.idb;
			db.#info = { module: opened.module, format: opened.format, arch: opened.arch, bitness: opened.bitness };
			db.#opened = true;
			db.#scheduleIdleWork();
			return db;
		} catch (error) {
			await db.#kill();
			if (loc.kind === "store" && loc.isNew) await removeCreationLeftovers(loc);
			throw error;
		}
	}

	/** Reference `read` and `ida db=` resolve back to this database: the source path plus `:@<arch>` for a universal binary slice. */
	get ref(): string {
		return this.fat ? `${this.sourcePath}${SLICE_SEPARATOR}${this.fat.slice.arch}` : this.sourcePath;
	}

	/** Path of the IDB file as reported by IDA. */
	get idbPath(): string {
		return this.#idbPath;
	}

	/** Loader facts reported when the database opened. */
	get info(): IdaDatabaseInfo {
		return this.#info;
	}

	/** When the last request was issued (epoch ms); LRU eviction closes the oldest idle database first. */
	get lastUsed(): number {
		return this.#lastUsed;
	}

	/** Whether requests are queued or in flight; busy databases are never evicted. */
	get busy(): boolean {
		return this.#active > 0;
	}

	/** The request the worker is executing now, if any. */
	get current(): IdaRunningRequest | null {
		return this.#current;
	}

	/**
	 * Send one request to the worker, serialized behind earlier requests. `timeoutMs` covers the
	 * queue wait too: a request still queued at its deadline fails with a {@link ToolError} naming
	 * the running request, without interrupting it (it belongs to another caller). A timeout or
	 * abort while executing sends SIGINT and waits {@link INTERRUPT_GRACE_MS} for the answer; a
	 * worker that does not answer is killed. Worker-side failures surface as {@link ToolError}.
	 */
	async request<T>(method: IdaMethod, params: object, options: IdaRequestOptions = {}): Promise<T> {
		if (this.#exitCode !== null) throw this.#exitError();
		const { signal, timeoutMs } = options;
		const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		this.#active++;
		this.#lastUsed = Date.now();
		this.#clearIdleTimers();
		const previous = this.#queue;
		const turn = Promise.withResolvers<void>();
		this.#queue = previous.then(() => turn.promise);
		try {
			await this.#waitTurn(previous, signal, timeoutMs);
			const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
			const value = await this.#send(method, params, { signal, timeoutMs: remaining });
			// The worker answers with the JSON shape documented for `method`.
			return value as T;
		} finally {
			turn.resolve();
			this.#active--;
			if (this.#active === 0) this.#scheduleIdleWork();
		}
	}

	/** Wait for `previous` (the queue ahead), bounded by the signal and `timeoutMs`. */
	async #waitTurn(
		previous: Promise<void>,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<void> {
		const queued = untilAborted(signal, previous);
		if (timeoutMs === undefined) return queued;
		const wait = delay(timeoutMs);
		try {
			const ready = await Promise.race([queued.then(() => true), wait.promise.then(() => false)]);
			if (ready) return;
		} finally {
			wait.cancel();
		}
		const running = this.#current;
		throw new ToolError(
			running
				? `IDA ${this.id} busy: ${running.method} running for ${Math.round((Date.now() - running.startedAt) / 1000)}s; retry later or raise timeout`
				: `IDA ${this.id} busy: queued requests did not finish within ${Math.round(timeoutMs / 1000)}s`,
		);
	}

	/** Arm the idle autosave (when dirty) and idle close (when enabled); any request disarms both. */
	#scheduleIdleWork(): void {
		this.#clearIdleTimers();
		if (!this.#opened || this.#closing || this.#exitCode !== null) return;
		if (this.#dirty) {
			this.#autosaveTimer = setTimeout(() => {
				if (this.#active > 0 || this.#closing) return;
				this.request("save", {}, { timeoutMs: CLOSE_TIMEOUT_MS }).catch(error => {
					logger.warn("IDA autosave failed", { id: this.id, error: errorMessage(error) });
				});
			}, AUTOSAVE_IDLE_MS);
			this.#autosaveTimer.unref();
		}
		if (this.#idleCloseMs > 0) {
			this.#idleTimer = setTimeout(() => {
				if (this.#active > 0 || this.#closing) return;
				this.close({ save: true }).catch(error => {
					logger.warn("IDA idle close failed", { id: this.id, error: errorMessage(error) });
				});
			}, this.#idleCloseMs);
			this.#idleTimer.unref();
		}
	}

	#clearIdleTimers(): void {
		clearTimeout(this.#autosaveTimer);
		clearTimeout(this.#idleTimer);
		this.#autosaveTimer = undefined;
		this.#idleTimer = undefined;
	}

	/** Close the worker (saving first when `save`), wait for it to exit, then release the lock and unregister. */
	close(options: { save: boolean }): Promise<void> {
		this.#closing ??= this.#close(options.save);
		return this.#closing;
	}

	async #close(save: boolean): Promise<void> {
		try {
			await this.request("close", { save }, { timeoutMs: CLOSE_TIMEOUT_MS });
			const grace = delay(EXIT_GRACE_MS);
			const exited = await Promise.race([this.#proc.exited.then(() => true), grace.promise.then(() => false)]);
			grace.cancel();
			if (!exited) await this.#kill();
		} catch (error) {
			await this.#kill();
			throw error;
		} finally {
			this.#release();
		}
	}

	async #send(method: IdaMethod, params: object, options: IdaRequestOptions): Promise<unknown> {
		if (this.#exitCode !== null) throw this.#exitError();
		const id = this.#nextId++;
		const response = Promise.withResolvers<unknown>();
		this.#pending.set(id, response);
		this.#current = { method, startedAt: Date.now() };
		try {
			try {
				this.#proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
				await this.#proc.stdin.flush();
			} catch (error) {
				if (this.#exitCode !== null) throw this.#exitError();
				throw new ToolError(`Failed to send ${method} to the IDA worker for ${this.id}: ${errorMessage(error)}`);
			}

			const { signal, timeoutMs } = options;
			const interrupted = Promise.withResolvers<RequestOutcome>();
			const onInterrupt = () => interrupted.resolve({ kind: "interrupted" });
			const deadline = timeoutMs === undefined ? undefined : delay(timeoutMs);
			void deadline?.promise.then(onInterrupt);
			signal?.addEventListener("abort", onInterrupt, { once: true });
			if (signal?.aborted) onInterrupt();
			try {
				const first = await Promise.race([
					response.promise.then((value): RequestOutcome => ({ kind: "response", value })),
					interrupted.promise,
				]);
				if (first.kind === "response") return first.value;
			} finally {
				deadline?.cancel();
				signal?.removeEventListener("abort", onInterrupt);
			}

			try {
				this.#proc.kill("SIGINT");
			} catch {
				// Already gone: the exit handler rejects the pending response.
			}
			const grace = delay(INTERRUPT_GRACE_MS);
			try {
				const late = await Promise.race([
					response.promise.then((value): RequestOutcome => ({ kind: "response", value })),
					grace.promise.then((): RequestOutcome => ({ kind: "interrupted" })),
				]);
				if (late.kind === "response") return late.value;
			} finally {
				grace.cancel();
			}
			this.#pending.delete(id);
			await this.#kill();
			throw new ToolError(
				`IDA ${method} did not stop after interrupt; worker killed, changes since the last save are lost`,
			);
		} finally {
			this.#pending.delete(id);
			this.#current = null;
		}
	}

	async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const bytes of readLines(stream)) {
				const line = decoder.decode(bytes).trim();
				if (!line) continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					logger.warn("IDA worker wrote non-JSON to its protocol stream", {
						id: this.id,
						line: line.slice(0, 200),
					});
					continue;
				}
				const response = parseWorkerResponse(frame);
				const entry = response ? this.#pending.get(response.id) : undefined;
				if (!response || !entry) {
					logger.warn("IDA worker sent an unmatched response", { id: this.id, line: line.slice(0, 200) });
					continue;
				}
				this.#pending.delete(response.id);
				if (response.ok) {
					if (response.dirty !== undefined) this.#dirty = response.dirty;
					entry.resolve(response.result);
				} else {
					entry.reject(new ToolError(response.message));
				}
			}
		} catch (error) {
			logger.warn("IDA worker stdout reader failed", { id: this.id, error: errorMessage(error) });
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) {
				this.#appendStderr(decoder.decode(chunk, { stream: true }));
			}
			this.#appendStderr(decoder.decode());
		} catch (error) {
			logger.debug("IDA worker stderr reader failed", { id: this.id, error: errorMessage(error) });
		}
	}

	#appendStderr(text: string): void {
		if (!text) return;
		const tail = this.#stderrTail + text;
		this.#stderrTail = tail.length > STDERR_TAIL_CHARS ? tail.slice(-STDERR_TAIL_CHARS) : tail;
	}

	async #onExit(code: number): Promise<void> {
		this.#exitCode = code;
		this.#clearIdleTimers();
		if (this.#opened) this.#release();
		// A response written right before exit (e.g. `close`) must settle before pending requests fail.
		const drain = delay(STREAM_DRAIN_MS);
		await Promise.race([this.#streamsDrained, drain.promise]);
		drain.cancel();
		const error = this.#exitError();
		for (const entry of this.#pending.values()) entry.reject(error);
		this.#pending.clear();
	}

	#exitError(): ToolError {
		const tail = this.#stderrTail.trimEnd();
		const lines = tail ? tail.split("\n").slice(-STDERR_TAIL_LINES).join("\n") : "";
		return new ToolError(`IDA worker for ${this.id} exited (code ${this.#exitCode})${lines ? `: ${lines}` : ""}`);
	}

	/** SIGKILL the worker (and its process group) and wait for it to exit. */
	async #kill(): Promise<void> {
		if (this.#exitCode === null) {
			try {
				this.#proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			killProcessGroup(this.#proc.pid, "SIGKILL");
		}
		await this.#proc.exited;
	}

	#release(): void {
		if (databases.get(this.id) === this) databases.delete(this.id);
		this.#lock.release();
	}
}

/** Delete everything a failed creation left in the store dir except the staged input and the lock file. */
async function removeCreationLeftovers(loc: IdbLocation): Promise<void> {
	const keep = new Set([sanitizeIdbName(path.basename(loc.sourcePath)), `${path.basename(loc.lockTarget)}.lock`]);
	try {
		const entries = await fs.promises.readdir(loc.dir);
		await Promise.all(
			entries
				.filter(entry => !keep.has(entry))
				.map(entry => fs.promises.rm(path.join(loc.dir, entry), { recursive: true, force: true })),
		);
	} catch (error) {
		logger.warn("IDA cleanup after failed database creation failed", { id: loc.id, error: errorMessage(error) });
	}
}

function registerIdaCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	postmortem.register("ida-cleanup", closeAllIdaDatabases);
}

/**
 * Open `loc` in a new worker. Makes room first by saving and closing the least recently used
 * idle database while `ida.maxOpen` would be exceeded; throws when every open database is busy.
 */
async function openIdaDatabase(session: ToolSession, loc: IdbLocation): Promise<IdaDatabase> {
	const maxOpen = Math.max(1, cfgIdaMaxOpen.get(session.settings));
	// Slots held by open databases and by other in-flight opens (`pending` may already hold this one).
	while (databases.size + pending.size - (pending.has(loc.id) ? 1 : 0) >= maxOpen) {
		const victim = listIdaDatabases()
			.filter(db => !db.busy)
			.sort((a, b) => a.lastUsed - b.lastUsed)[0];
		if (!victim) {
			const ids = listIdaDatabases().map(db => db.id);
			throw new ToolError(
				`IDA database limit reached (${maxOpen} open, all busy: ${ids.join(", ")}); close one with ida close or raise ida.maxOpen`,
			);
		}
		await victim.close({ save: true });
	}
	// The lock file lives in the store dir; `locateIdb` leaves it uncreated for pure lookups.
	if (loc.kind === "store") await fs.promises.mkdir(loc.dir, { recursive: true });
	const lock = await acquireFileLock(loc.lockTarget, { retries: 1 }).catch(() => {
		throw new ToolError(`IDB ${loc.id} is in use by another omp process`);
	});
	try {
		await prepareStoreDir(loc);
		const runtime = await resolveIdaRuntime(session);
		registerIdaCleanup();
		const db = await IdaDatabase.start(loc, runtime, lock, cfgIdaIdleCloseSec.get(session.settings) * 1000);
		databases.set(loc.id, db);
		return db;
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Options for {@link acquireIdaDatabase}. */
export interface AcquireIdaDatabaseOptions extends LocateIdbOptions {
	signal?: AbortSignal;
}

/**
 * Return the live database for a binary (or one slice of a universal binary) or `.i64`/`.idb`,
 * opening (or creating) it on first use. Concurrent callers for the same database share one open;
 * aborting `signal` stops only this caller's wait, the open itself always runs to completion.
 */
export async function acquireIdaDatabase(
	session: ToolSession,
	sourcePath: string,
	options: AcquireIdaDatabaseOptions = {},
): Promise<IdaDatabase> {
	const { signal, arch } = options;
	const loc = await locateIdb(sourcePath, { arch });
	const open = databases.get(loc.id);
	if (open) return open;
	let opening = pending.get(loc.id);
	if (!opening) {
		opening = openIdaDatabase(session, loc).finally(() => pending.delete(loc.id));
		// Every caller may have stopped waiting; remaining ones still receive the failure.
		opening.catch(error => logger.debug("IDA database open failed", { id: loc.id, error: errorMessage(error) }));
		pending.set(loc.id, opening);
	}
	return untilAborted(signal, opening);
}

/** The open database registered under `id`, if any. */
export function findOpenIdaDatabase(id: string): IdaDatabase | undefined {
	return databases.get(id);
}

/** Every open database in this process. */
export function listIdaDatabases(): IdaDatabase[] {
	return Array.from(databases.values());
}

/** Close the open database `id` (saving first when `save`); throws when it is not open. */
export async function closeIdaDatabase(id: string, options: { save: boolean }): Promise<void> {
	const db = databases.get(id);
	if (!db) throw new ToolError(`IDA database ${id} is not open`);
	await db.close(options);
}

/** Save and close every open database; failures are logged, not thrown. */
export async function closeAllIdaDatabases(): Promise<void> {
	await Promise.all(
		Array.from(databases.values(), async db => {
			try {
				await db.close({ save: true });
			} catch (error) {
				logger.warn("IDA close on exit failed", { id: db.id, error: errorMessage(error) });
			}
		}),
	);
}
