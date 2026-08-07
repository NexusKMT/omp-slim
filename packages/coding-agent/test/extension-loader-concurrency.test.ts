/**
 * Regression test for #7615: extension module imports must run concurrently
 * (cold-start cost was linear in the number of installed extensions), while
 * factory binding stays sequential in path order so registration semantics
 * (last-wins collisions, shared runtime flag defaults) remain deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

const EVENTS_KEY = "__ompExtensionLoaderConcurrencyEvents";

interface EventsGlobal {
	__ompExtensionLoaderConcurrencyEvents?: string[];
}

const eventsGlobal = globalThis as EventsGlobal;

describe("extension loader concurrency (#7615)", () => {
	let project: TempDir | undefined;

	beforeEach(() => {
		project = TempDir.createSync("@omp-ext-concurrency-");
		eventsGlobal[EVENTS_KEY] = [];
	});

	afterEach(() => {
		project?.removeSync();
		project = undefined;
		delete eventsGlobal[EVENTS_KEY];
	});

	const writeModule = (relativePath: string, source: string): string => {
		expect(project).toBeDefined();
		const filePath = path.join(project!.path(), relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, source);
		return filePath;
	};

	it("imports modules concurrently but binds factories in path order", async () => {
		const slowPath = writeModule(
			"slow.ts",
			`const events = (globalThis as { ${EVENTS_KEY}?: string[] }).${EVENTS_KEY}!;
events.push("slow:eval:start");
await Bun.sleep(250);
events.push("slow:eval:end");
export default function slowExtension() {
	events.push("slow:factory");
}
`,
		);
		const fastPath = writeModule(
			"fast.ts",
			`const events = (globalThis as { ${EVENTS_KEY}?: string[] }).${EVENTS_KEY}!;
events.push("fast:eval");
export default function fastExtension() {
	events.push("fast:factory");
}
`,
		);

		const result = await loadExtensions([slowPath, fastPath], project!.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions.map(ext => ext.path)).toEqual([slowPath, fastPath]);

		const events = eventsGlobal[EVENTS_KEY]!;
		// Concurrent import: the fast module evaluates while the slow module's
		// top-level await is still pending. Sequential loading would force
		// "fast:eval" after "slow:eval:end".
		expect(events.indexOf("fast:eval")).toBeLessThan(events.indexOf("slow:eval:end"));
		// Deterministic binding: factories run in the original path order even
		// though the fast module finished importing first.
		expect(events.indexOf("slow:factory")).toBeLessThan(events.indexOf("fast:factory"));
		expect(events.indexOf("slow:eval:end")).toBeLessThan(events.indexOf("slow:factory"));
	});

	it("isolates per-extension import failures without blocking the batch", async () => {
		const brokenPath = writeModule(
			"broken.ts",
			`throw new Error("boom at import time");
`,
		);
		const okPath = writeModule(
			"ok.ts",
			`const events = (globalThis as { ${EVENTS_KEY}?: string[] }).${EVENTS_KEY}!;
export default function okExtension() {
	events.push("ok:factory");
}
`,
		);

		const result = await loadExtensions([brokenPath, okPath], project!.path());

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.path).toBe(brokenPath);
		expect(result.errors[0]!.error).toContain("boom at import time");
		expect(result.extensions.map(ext => ext.path)).toEqual([okPath]);
		expect(eventsGlobal[EVENTS_KEY]).toContain("ok:factory");
	});
});
