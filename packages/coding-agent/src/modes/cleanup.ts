/**
 * Async cleanup registry for graceful shutdown on signals.
 */

/** Registry of async cleanup callbacks to run on shutdown/signals */
const asyncCleanupCallbacks: (() => Promise<void>)[] = [];

/**
 * Register an async cleanup callback to be run on process signals (SIGINT, SIGTERM, SIGHUP).
 * Returns an unsubscribe function.
 */
export function registerAsyncCleanup(callback: () => Promise<void>): () => void {
	asyncCleanupCallbacks.push(callback);
	return () => {
		const index = asyncCleanupCallbacks.indexOf(callback);
		if (index >= 0) asyncCleanupCallbacks.splice(index, 1);
	};
}

/** Run all registered async cleanup callbacks, settling all promises */
export async function runAsyncCleanup(): Promise<void> {
	await Promise.allSettled(asyncCleanupCallbacks.map((cb) => cb()));
}
