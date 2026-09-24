import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import { listServices, sendService, startService, waitForOwnedServiceCompletion } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	return broker;
}

describe("session-owned supervised services", () => {
	it("delivers a failed service only to its session when another session shares the broker", async () => {
		using tempDir = TempDir.createSync("@omp-service-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const settings = Settings.isolated();
		const firstCompletions: DaemonCompletionNotification[] = [];
		const secondCompletions: DaemonCompletionNotification[] = [];
		const makeSession = (sessionId: string, completions: DaemonCompletionNotification[]): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			queueLaunchCompletion: notification => {
				if (notification.owner !== sessionId)
					return Promise.reject(new Error("Completion delivered to wrong session"));
				completions.push(notification);
				return Promise.resolve();
			},
		});
		const first = makeSession("first-session", firstCompletions);
		const second = makeSession("second-session", secondCompletions);
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			const started = await startService(first, {
				name: "failing-service",
				command: "echo service-ready; read answer; exit 3",
				ready: { log: "service-ready", timeout: 5 },
			});
			expect(started.daemon.state).toBe("ready");
			expect(started.daemon.owner).toBe("first-session");
			await listServices(second);
			const firstFinished = waitForOwnedServiceCompletion(first);
			await sendService(first, "failing-service", "go\n");
			await firstFinished;
			expect(firstCompletions.map(({ daemon }) => [daemon.name, daemon.state, daemon.exitCode])).toEqual([
				["failing-service", "failed", 3],
			]);
			expect(secondCompletions).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 15_000);
});
