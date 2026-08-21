import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";

function createSession(cwd = process.cwd()): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const tool = new GlobTool(createSession());
	let thrown: unknown;
	try {
		await tool.execute("glob-root-regression", { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected glob path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("GlobTool.execute", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});

	test("does not finish a timeout until the native scan has stopped", async () => {
		const started = Promise.withResolvers<void>();
		const timeoutObserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let nativeSettled = false;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 100,
			nativeGlob: async options => {
				const nativeSignal = options.signal as AbortSignal | undefined;
				if (!nativeSignal) {
					started.resolve();
					timeoutObserved.resolve();
					throw new Error("Missing native cancellation signal");
				}
				nativeSignal.addEventListener("abort", () => timeoutObserved.resolve(), { once: true });
				started.resolve();
				await timeoutObserved.promise;
				await release.promise;
				nativeSettled = true;
				throw new Error("GenericFailure, Aborted: Timeout");
			},
		});

		const execution = tool.execute("glob-timeout-cleanup", { path: "." });
		await started.promise;
		await timeoutObserved.promise;
		const stateBeforeCleanup = await Promise.race([
			execution.then(
				() => "settled",
				() => "settled",
			),
			Promise.resolve("pending"),
		]);
		expect(stateBeforeCleanup).toBe("pending");

		release.resolve();
		const result = await execution;

		expect(nativeSettled).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Glob timed out after 0.1s");
	});

	test("waits for every native scan to settle before rejecting an abort", async () => {
		const controller = new AbortController();
		const allStarted = Promise.withResolvers<void>();
		const allAborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let startedCount = 0;
		let abortedCount = 0;
		let settledCount = 0;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 5000,
			nativeGlob: async options => {
				const nativeSignal = options.signal as AbortSignal | undefined;
				if (!nativeSignal) throw new Error("Missing native cancellation signal");
				const abortObserved = Promise.withResolvers<void>();
				nativeSignal.addEventListener(
					"abort",
					() => {
						abortedCount += 1;
						if (abortedCount === 2) allAborted.resolve();
						abortObserved.resolve();
					},
					{ once: true },
				);
				startedCount += 1;
				if (startedCount === 2) allStarted.resolve();
				await abortObserved.promise;
				await release.promise;
				settledCount += 1;
				throw new Error("GenericFailure, Aborted: Signal");
			},
		});
		const execution = tool.execute(
			"glob-abort-cleanup",
			{ path: `.; ${path.dirname(process.cwd())}` },
			controller.signal,
		);

		await allStarted.promise;
		controller.abort();
		await allAborted.promise;
		const stateBeforeCleanup = await Promise.race([
			execution.then(
				() => "settled",
				() => "settled",
			),
			Promise.resolve("pending"),
		]);
		expect(stateBeforeCleanup).toBe("pending");

		release.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(settledCount).toBe(2);
	});
});
