import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import * as connectionManager from "../../src/ssh/connection-manager";
import { listRemoteDir, readRemoteFile, statRemotePath, writeRemoteFile } from "../../src/ssh/file-transfer";

describe("ssh file-transfer POSIX guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a remote with no verified transferShell", async () => {
		// No transferShell means the capability probe never confirmed any of
		// sh/bash/zsh works. The guard refuses regardless of `shell` because the
		// real ssh:// contract is "did we verify a POSIX shell works", not
		// "what name did the login shell self-report" (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "unknown",
		});
		const target: SSHConnectionTarget = { name: "noshell", host: "noshell" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(
			/no verified POSIX shell.*use `bash` with a remote SSH command/,
		);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(
			/no verified POSIX shell.*use `bash` with a remote SSH command/,
		);
	});

	it("dispatches transfer commands through the verified transferShell, not the login shell", async () => {
		// The bug fix: if the login shell is fish/csh/tcsh, the legacy guard
		// would refuse the host — but allowing it isn't enough on its own.
		// OpenSSH still hands our snippets to `$SHELL -c`, so a fish login
		// shell would choke on `if [ … ]; then …`. Every transfer command
		// must be wrapped in `<transferShell> -c '…'` to force parsing
		// under the shell we verified can run it (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			// Login shell is fish; only `transferShell` indicates a working POSIX shell.
			shell: "unknown",
			transferShell: "bash",
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "fishbox", host: "fishbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);
		await expect(statRemotePath(target, "/etc/hosts")).rejects.toThrow(/stop-before-spawn/);
		await expect(listRemoteDir(target, "/etc")).rejects.toThrow(/stop-before-spawn/);

		// Each dispatch must start with `bash -c '…'` and embed the original
		// POSIX snippet inside the quoted command. Read also drops `-n`
		// (allowStdin: true) because cat-staging needs stdin streaming.
		const dispatches = buildSpy.mock.calls.map(call => call[1] as string);
		expect(dispatches[0]).toMatch(/^bash -c '.*head -c 1025/);
		expect(dispatches[1]).toMatch(/^bash -c '.*cat > /);
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
		expect(dispatches[2]).toMatch(/^bash -c '.*if \[ -d /);
		expect(dispatches[3]).toMatch(/^bash -c '.*LC_ALL=C find /);
	});
});
