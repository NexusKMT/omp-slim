import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import { ToolError, throwIfAborted } from "./tool-errors";

const BROWSER_RUN_REJECTION = Symbol.for("omp.browserRunRejection");

export function markBrowserRunRejection<T>(reason: T): T {
	if (reason !== null && (typeof reason === "object" || typeof reason === "function")) {
		Reflect.set(reason, BROWSER_RUN_REJECTION, true);
	}
	return reason;
}

function isBrowserRunRejection(reason: unknown): boolean {
	let current = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if (Reflect.get(current, BROWSER_RUN_REJECTION) === true) return true;
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}

function consumeBrowserRunRejection(reason: unknown): boolean {
	if (!isBrowserRunRejection(reason)) return false;
	logger.warn("Contained unhandled browser-run rejection (missing await?)", {
		error: reason instanceof Error ? reason.message : String(reason),
	});
	return true;
}

postmortem.interceptUnhandledRejections(consumeBrowserRunRejection);

/**
 * Observe every continuation created from a browser facade promise. A catch on
 * only the original promise does not cover `tab.waitForResponse(...).then(...)`:
 * `then` creates a fresh rejection that can otherwise kill or wedge the worker.
 */
const observedPromiseTrees = new WeakSet<Promise<unknown>>();

function observePromiseTree<T>(promise: Promise<T>): Promise<T> {
	if (observedPromiseTrees.has(promise)) return promise;
	observedPromiseTrees.add(promise);
	markHandled(promise);
	const originalThen = promise.then.bind(promise);
	const originalCatch = promise.catch.bind(promise);
	const originalFinally = promise.finally.bind(promise);
	Object.defineProperties(promise, {
		// biome-ignore lint/suspicious/noThenProperty: native Promise continuations must remain thenable.
		then: {
			configurable: true,
			value: <TResult1 = T, TResult2 = never>(
				onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
				onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
			): Promise<TResult1 | TResult2> => observePromiseTree(originalThen(onFulfilled, onRejected)),
		},
		catch: {
			configurable: true,
			value: <TResult = never>(
				onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
			): Promise<T | TResult> => observePromiseTree(originalCatch(onRejected)),
		},
		finally: {
			configurable: true,
			value: (onFinally?: (() => void) | null): Promise<T> => observePromiseTree(originalFinally(onFinally)),
		},
	});
	return promise;
}

function trackBrowserRunPromise<T>(promise: Promise<T>): Promise<T> {
	const tracked = promise.catch(error => {
		throw markBrowserRunRejection(error);
	});
	return observePromiseTree(tracked);
}

/**
 * Marks a run-scoped promise as observed without changing its behavior for awaited callers.
 *
 * Run teardown aborts can reject promises created for evaluated code after user code
 * has stopped observing them (for example fire-and-forget `wait()`/facade calls). In 16.3.0
 * those zero-consumer rejections reached the process-level `unhandledRejection` handler and
 * killed every subagent sharing the process (issues #4499/#4672). Attaching a no-op rejection
 * handler at creation makes the promise observed while returning the original promise so callers
 * that do await it still receive the rejection.
 */
export function markHandled<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}

/** Headroom subtracted from the cell budget so an in-run deadline fires before the opaque whole-cell timeout. */
export const CELL_BUDGET_SLACK_MS = 1_000;

/** Default poll deadline for `wait(predicate)` before clamping to the cell budget. */
export const DEFAULT_PREDICATE_TIMEOUT_MS = 30_000;

/** Options for the predicate form of the run-scoped `wait()` helper. */
export interface WaitPredicateOptions {
	/** Max time to poll before failing, in ms (default 30s, clamped to the cell budget). */
	timeout?: number;
	/** Poll interval in ms (default 100, floor 10). */
	interval?: number;
}

/**
 * Effective `wait(predicate)` deadline for a given cell budget. Always strictly below
 * the cell budget so the named `wait(predicate) timed out` error wins the race against
 * the opaque whole-cell execution timeout. `0`/`Infinity` ("disable") map to the largest
 * bounded deadline; negative/NaN garbage falls back to the default.
 */
export function resolvePredicateTimeout(cellTimeoutMs: number, explicit?: number): number {
	const budgetBound = Math.max(1, cellTimeoutMs - CELL_BUDGET_SLACK_MS);
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return Math.min(DEFAULT_PREDICATE_TIMEOUT_MS, budgetBound);
}

/**
 * Run-scoped `wait()` helper for evaluated code (browser and computer workers), honoring
 * the owning run's cancellation signal.
 *
 * - `wait(ms)` sleeps for `ms` milliseconds.
 * - `wait(fn, { timeout?, interval? })` polls `fn` (sync or async) until it returns a
 *   truthy value and resolves with that value; throws a named `ToolError` on timeout
 *   instead of stalling into the whole-cell deadline. Predicate errors propagate.
 */
export function waitForRun(
	msOrPredicate: number | (() => unknown),
	signal: AbortSignal,
	opts?: WaitPredicateOptions,
): Promise<unknown> {
	const promise = (async (): Promise<unknown> => {
		throwIfAborted(signal);
		if (typeof msOrPredicate === "number") {
			await untilAborted(signal, async () => await Bun.sleep(msOrPredicate));
			throwIfAborted(signal);
			return undefined;
		}
		if (typeof msOrPredicate !== "function") {
			throw new ToolError("wait(...) expects milliseconds (number) or a predicate function to poll");
		}
		const timeout =
			opts?.timeout !== undefined && Number.isFinite(opts.timeout) && opts.timeout > 0
				? opts.timeout
				: DEFAULT_PREDICATE_TIMEOUT_MS;
		const interval = Math.max(opts?.interval ?? 100, 10);
		const deadline = Date.now() + timeout;
		for (;;) {
			const value = await untilAborted(signal, async () => await msOrPredicate());
			throwIfAborted(signal);
			if (value) return value;
			if (Date.now() + interval > deadline) {
				throw new ToolError(`wait(predicate) timed out after ${timeout}ms — predicate never returned truthy`);
			}
			await untilAborted(signal, async () => await Bun.sleep(interval));
		}
	})();
	return trackBrowserRunPromise(promise);
}

/** Binds a long-lived scope facade (page/tab/desktop objects) to one evaluated run's abort signal. */
export function bindRunFacade<T extends object>(target: T, signal: AbortSignal): T {
	const cache = new Map<PropertyKey, unknown>();
	return new Proxy(target, {
		get(current, prop) {
			throwIfAborted(signal);
			const cached = cache.get(prop);
			if (cached) return cached;
			const value = Reflect.get(current, prop, current);
			if (typeof value === "function") {
				const wrapped = (...args: unknown[]): unknown => {
					throwIfAborted(signal);
					const result = Reflect.apply(value, current, args);
					if (result && typeof result === "object") {
						const then = Reflect.get(result, "then");
						if (typeof then === "function") {
							return trackBrowserRunPromise(
								Promise.resolve(result).then(
									resolved => {
										throwIfAborted(signal);
										return resolved;
									},
									error => {
										throw markBrowserRunRejection(error);
									},
								),
							);
						}
					}
					throwIfAborted(signal);
					return result;
				};
				cache.set(prop, wrapped);
				return wrapped;
			}
			if (value && typeof value === "object") {
				// Never proxy AbortSignals: native combinators (AbortSignal.any, fetch)
				// brand-check internal slots that a Proxy cannot forward, and reading a
				// signal needs no abort gating anyway.
				if (value instanceof AbortSignal) return value;
				const wrapped = bindRunFacade(value, signal);
				cache.set(prop, wrapped);
				return wrapped;
			}
			return value;
		},
	});
}
