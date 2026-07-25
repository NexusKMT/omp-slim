const worker = new Worker(new URL("../../src/computer-worker-process-entry.ts", import.meta.url).href, {
	type: "module",
});
const response = Promise.withResolvers<unknown>();
worker.addEventListener("message", event => response.resolve(event.data));
worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
worker.postMessage({ type: "ping", id: "computer-process-entry" });
try {
	process.stdout.write(`${JSON.stringify(await response.promise)}\n`);
} finally {
	worker.terminate();
}
