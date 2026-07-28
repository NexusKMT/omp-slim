// Integration test — real timers are required (ts-no-test-timers exception): this spawns the
// actual cross-process daemon broker driving real child processes, and the bug is a leaked real
// `setTimeout` in #settle that resurrects a stopped daemon. Fake timers cannot control the OS
// process-exit promise or the unix-socket RPC the broker relies on, and proving the *absence* of a
// resurrection means waiting past the real backoff window (no signal exists to await).
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSnapshot,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function snapshotOf(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === name);
	if (!daemon) throw new Error(`daemon ${name} not listed`);
	return daemon;
}

async function waitForState(
	client: DaemonBrokerClient,
	name: string,
	state: DaemonSnapshot["state"],
	deadlineMs: number,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await snapshotOf(client, name);
		if (daemon.state === state) return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never reached state ${state}`);
}

describe("daemon broker restart settling", () => {
	it("does not re-settle a restarting detached daemon on ops, keeping stop authoritative", async () => {
		using tempDir = TempDir.createSync("@omp-launch-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
		const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
		const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
		const name = "crash-loop";
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					// Fast-exit child: exits 0 immediately, so restart:"always" parks it in `restarting`.
					application: process.execPath,
					args: ["-e", "process.exit(0)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: true,
				},
			});
			expect(started.op).toBe("start");

			// Enter the restarting backoff window and record the restart count.
			const restarting = await waitForState(client, name, "restarting", 5_000);
			const baseline = restarting.restartCount;

			// Poll while restarting. Each op runs #refreshDetached; a re-entrant #settle would
			// phantom-increment restartCount and leak an armed timer (issue #6852).
			for (let i = 0; i < 3; i++) {
				const seen = await snapshotOf(client, name);
				expect(seen.state).toBe("restarting");
				expect(seen.restartCount).toBe(baseline);
			}

			// Stop must be authoritative: clears the single armed timer, no orphaned timer resurrects.
			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");

			// Wait past the initial backoff (2s) where a leaked timer would have fired #launch.
			await Bun.sleep(2_600);
			const afterStop = await snapshotOf(client, name);
			expect(afterStop.state).toBe("exited");
			expect(afterStop.pid).toBeUndefined();
			expect(afterStop.restartCount).toBe(baseline);
		} finally {
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	}, 20_000);
});
