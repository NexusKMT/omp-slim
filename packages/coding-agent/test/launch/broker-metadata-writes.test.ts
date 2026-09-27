import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function startBroker(projectDir: string, runtimeDir: string): { listening: Promise<boolean>; finished: Promise<void> } {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	return { listening: listening.promise, finished };
}

describe("daemon metadata writes", () => {
	it("does not rewrite settled history on subscriber changes or broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-broker-metadata-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const metadataPath = path.join(runtimeDir, "daemons", "historical", "meta.json");
		await fs.mkdir(projectDir);
		await Bun.write(
			metadataPath,
			JSON.stringify({
				daemon: {
					name: "historical",
					id: "historical",
					state: "exited",
					owner: "shared-session",
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
				spec: {
					name: "historical",
					application: process.execPath,
					args: [],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			}),
		);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			await first.request({ op: "ping" });
			const inode = (await fs.stat(metadataPath)).ino;
			first.onCompletion("shared-session", () => undefined);
			second.onCompletion("shared-session", () => undefined);
			for (let index = 0; index < 3; index++) {
				await first.request({ op: "ping" });
				await second.request({ op: "ping" });
			}
			expect((await fs.stat(metadataPath)).ino).toBe(inode);
			await first.request({ op: "shutdown" });
			first.close();
			second.close();
			await broker.finished;

			const restarted = startBroker(projectDir, runtimeDir);
			const restartClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			try {
				await restarted.listening;
				await restartClient.request({ op: "ping" });
				expect((await fs.stat(metadataPath)).ino).toBe(inode);
			} finally {
				await restartClient.request({ op: "shutdown" }).catch(() => undefined);
				restartClient.close();
				await restarted.finished;
			}
		} finally {
			await first.request({ op: "shutdown" }).catch(() => undefined);
			first.close();
			second.close();
			await broker.finished;
		}
	}, 20_000);
});
