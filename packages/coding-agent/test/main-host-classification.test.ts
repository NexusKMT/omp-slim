import { afterEach, expect, it } from "bun:test";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
});

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;
	// An interactive launch needs a terminal on stdin; without one it exits 2.
	const originalIsTTY = process.stdin.isTTY;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
});
