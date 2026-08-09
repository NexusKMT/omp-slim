import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "./client";

// Broker PID lease file (internal to broker.ts); its removal is the observable
// signal that the broker process ran its shutdown path and released the lease.
const PID_FILE = "broker.pid";

const tempDirs: string[] = [];
let openClient: DaemonBrokerClient | undefined;

afterEach(async () => {
	openClient?.close();
	openClient = undefined;
	// A regression leaves the broker running; kill it so it does not outlive the
	// suite and hold the temp runtime dir.
	for (const dir of tempDirs) {
		try {
			const raw: unknown = await Bun.file(path.join(dir, PID_FILE)).json();
			if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") {
				try {
					process.kill(raw.pid, "SIGKILL");
				} catch {
					// Already gone — the expected outcome.
				}
			}
		} catch {
			// No PID file — broker already exited.
		}
	}
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.length = 0;
});

test("broker shuts down after its last persistent daemon exits with no clients", async () => {
	const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-idle-project-"));
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-idle-run-"));
	tempDirs.push(projectDir, runtimeDir);

	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
	openClient = client;

	// A persistent daemon that outlives the first idle-shutdown timer (200ms) and
	// then self-exits (~700ms). The first idle check must observe it live and
	// return; the broker must rearm idle shutdown once it settles.
	const started = await client.request({
		op: "start",
		spec: {
			name: "persistent-temp",
			application: process.execPath,
			args: ["-e", "setTimeout(() => {}, 700)"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: true,
			detached: false,
		},
	});
	expect(started.op).toBe("start");

	const pidPath = path.join(runtimeDir, PID_FILE);
	expect(await Bun.file(pidPath).exists()).toBe(true);

	// Disconnect the final client. The broker keeps the persistent daemon alive.
	client.close();
	openClient = undefined;

	// After the daemon self-exits, terminal settlement must rearm idle shutdown so
	// the broker releases its lease (removes the PID file). Await that filesystem
	// signal directly rather than polling. Integration test: the broker's idle
	// timer runs in a separate process against the real clock, so fake timers
	// cannot drive it — the removal event is the observable shutdown proof.
	let brokerExited = !(await Bun.file(pidPath).exists());
	if (!brokerExited) {
		const watcher = fs.watch(runtimeDir, { signal: AbortSignal.timeout(15_000) });
		try {
			for await (const event of watcher) {
				if (event.filename === PID_FILE && !(await Bun.file(pidPath).exists())) {
					brokerExited = true;
					break;
				}
			}
		} catch (error) {
			// AbortSignal.timeout aborts the watch with AbortError/TimeoutError once
			// the window elapses; that just means the broker never exited, so let the
			// assertion below report it. Rethrow anything else.
			const name = error instanceof Error ? error.name : "";
			if (name !== "AbortError" && name !== "TimeoutError") throw error;
		}
	}
	expect(brokerExited).toBe(true);
}, 20_000);
