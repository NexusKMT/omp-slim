/**
 * First browser use may download Chrome for Testing (~180 MB). That install
 * is not part of the open, so it must not be charged against the requested
 * `timeout`: with a 30s default it timed out on ordinary connections and left
 * agents believing the tool was broken. The caller's abort signal still cuts
 * the wait short.
 *
 * `ensureChromiumExecutable` is spied so no download or Chromium runs.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const DOWNLOAD_FAILED = "sentinel: Chromium install finished after the open timeout";

function createBrowserHost() {
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-open-download-test", signal });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("browser open during first-use Chromium download", () => {
	// Real clock on purpose: the contract is that the platform deadline
	// (`AbortSignal.timeout`, floor 1s via clampTimeout) starts after the
	// install, and only elapsed time can show it never fired.
	it("does not charge the download against the requested open timeout", async () => {
		const downloadMs = 1_500;
		spyOn(launch, "ensureChromiumExecutable").mockImplementation(async () => {
			await Bun.sleep(downloadMs);
			throw new ToolError(DOWNLOAD_FAILED);
		});
		const invoke = createBrowserHost();
		const started = performance.now();
		// timeout 1s < download 1.5s: a download inside the deadline would
		// surface "Browser open timed out" before the install ever finished.
		await expect(invoke({ action: "open", name: "download", url: "about:blank", timeout: 1 })).rejects.toThrow(
			DOWNLOAD_FAILED,
		);
		expect(performance.now() - started).toBeGreaterThanOrEqual(downloadMs - 50);
	});

	it("still lets the caller abort while the download is pending", async () => {
		const download = Promise.withResolvers<string>();
		const entered = Promise.withResolvers<void>();
		spyOn(launch, "ensureChromiumExecutable").mockImplementation(() => {
			entered.resolve();
			return download.promise;
		});
		const invoke = createBrowserHost();
		const controller = new AbortController();
		const opening = invoke({ action: "open", name: "download", url: "about:blank", timeout: 30 }, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(opening).rejects.toBeInstanceOf(ToolAbortError);
		download.reject(new ToolError(DOWNLOAD_FAILED));
	});
});
