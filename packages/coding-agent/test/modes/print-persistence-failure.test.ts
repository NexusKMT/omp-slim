/**
 * Contract (issue #11493): a latched store failure reaches a headless consumer —
 * print mode reports it on stderr and returns a nonzero code, RPC mode emits a
 * `notice` — instead of escaping as a raw fatal dump or going unreported.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeSessionQuietly } from "../../src/main";
import { runPrintMode } from "../../src/modes/print-mode";
import { formatPersistenceFailure } from "../../src/modes/persistence-failure";
import { registerRpcPersistenceSurface } from "../../src/modes/rpc/rpc-mode";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const tempDirs: TempDir[] = [];

function makeSessionManager(): SessionManager {
	const dir = TempDir.createSync("@pi-persistence-surface-");
	tempDirs.push(dir);
	const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
	return manager;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason: "stop",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function failWrites(): () => void {
	const spy = spyOn(fs, "writeSync").mockImplementation(() => {
		throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
	});
	return () => spy.mockRestore();
}

function captureStderr(): { written: () => string; restore: () => void } {
	const chunks: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as never);
	return { written: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/**
 * AgentSession.dispose() caches its first call, so a second await rethrows the
 * identical rejection instead of re-running teardown (agent-session.ts
 * `#disposeCall`).
 */
function memoizingDispose(manager: SessionManager): () => Promise<void> {
	let call: Promise<void> | undefined;
	return () => {
		call ??= manager.close();
		return call;
	};
}

function assistantSession(manager: SessionManager, dispose: () => Promise<void>): AgentSession {
	return {
		extensionRunner: undefined,
		subscribe: () => {},
		settings: { get: () => false },
		sessionManager: manager,
		getLastAssistantMessage: () => assistant(""),
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose,
	} as unknown as AgentSession;
}

describe("headless persistence-failure surface", () => {
	it("reports the store failure on stderr and returns a nonzero code from print mode", async () => {
		const manager = makeSessionManager();
		// No session file exists until an assistant message does, so the appends
		// below would never reach a writer without this.
		await manager.ensureOnDisk();
		manager.appendMessage(assistant("seed"));

		const restoreWrites = failWrites();
		const stderr = captureStderr();

		const session = {
			extensionRunner: undefined,
			subscribe: () => {},
			settings: { get: () => false },
			sessionManager: manager,
			getLastAssistantMessage: () => assistant(""),
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {
				manager.appendMessage({ role: "user", content: "boom-user", timestamp: Date.now() } as never);
			},
			dispose: async () => {
				await manager.close();
			},
		} as unknown as AgentSession;

		let exitCode = -1;
		try {
			exitCode = await runPrintMode(session, { mode: "text", initialMessage: "hello" });
		} finally {
			restoreWrites();
			stderr.restore();
		}

		const line = stderr.written();
		expect(line).toContain("Session persistence failed: ");
		expect(line).toContain("ENOSPC");
		expect(line).not.toContain("\u001b");
		expect(exitCode).toBe(1);
		expect(() => manager.flushSync()).toThrow("ENOSPC");
	});

	it("reports a recovered write failure as retryable instead of claiming lost durability", async () => {
		const manager = makeSessionManager();
		await manager.ensureOnDisk();
		manager.appendMessage(assistant("seed"));

		const restoreWritesOnce = failWrites();
		let restored = false;
		const restoreWrites = (): void => {
			if (restored) return;
			restored = true;
			restoreWritesOnce();
		};
		const stderr = captureStderr();

		const session = {
			extensionRunner: undefined,
			subscribe: () => {},
			settings: { get: () => false },
			sessionManager: manager,
			getLastAssistantMessage: () => assistant(""),
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async () => {
				// The store rejects this entry and keeps it in memory...
				manager.appendMessage({ role: "user", content: "boom-user", timestamp: Date.now() } as never);
				// ...then accepts the next write, so the retry rewrites the whole
				// transcript — both entries — and clears the store's failure latch.
				restoreWrites();
				manager.appendMessage({ role: "user", content: "recovered-user", timestamp: Date.now() } as never);
			},
			dispose: async () => {
				await manager.close();
			},
		} as unknown as AgentSession;

		let exitCode = -1;
		try {
			exitCode = await runPrintMode(session, { mode: "text", initialMessage: "hello" });
		} finally {
			stderr.restore();
			restoreWrites();
		}

		const reported = stderr
			.written()
			.split("\n")
			.filter(line => line.includes("Session persistence failed: "));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Writes are retried");
		// The transcript did become durable, so nothing may claim otherwise.
		expect(stderr.written()).not.toContain("not durable");
		expect(exitCode).toBe(0);

		const transcript = fs.readFileSync(manager.getSessionFile() as string, "utf8");
		expect(transcript).toContain("boom-user");
		expect(transcript).toContain("recovered-user");
	});

	it("emits a notice and a stderr line when an RPC session's store fails", () => {
		const manager = makeSessionManager();
		manager.appendMessage(assistant("seed"));

		const notices: Array<{ level: string; message: string; source?: string }> = [];
		const stderr = captureStderr();
		const restoreWrites = failWrites();
		registerRpcPersistenceSurface({
			sessionManager: manager,
			emitNotice: (level, message, source) => {
				notices.push({ level, message, source });
			},
		});

		try {
			manager.appendMessage({ role: "user", content: "boom-user", timestamp: Date.now() } as never);
		} finally {
			restoreWrites();
			stderr.restore();
		}

		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("error");
		expect(notices[0]?.source).toBe("session-persistence");
		expect(notices[0]?.message).toContain("Session persistence failed: ");
		expect(notices[0]?.message).toContain("ENOSPC");
		expect(notices[0]?.message).not.toContain("\n");
		expect(stderr.written()).toContain("ENOSPC");
	});

	it("collapses a multi-line, control-laden message into one clean line", () => {
		const formatted = formatPersistenceFailure("ENOSPC:\tdisk full\n\u001b[31mretry later\u001b[0m");
		expect(formatted).toContain("Session persistence failed: ENOSPC:");
		expect(formatted).not.toContain("\t");
		expect(formatted).not.toContain("\n");
		expect(formatted).not.toContain("\u001b");
	});

	it("reports a store failure latched before print mode subscribed, exactly once", async () => {
		const manager = makeSessionManager();
		// No session file exists until an assistant message does, so the appends
		// below would never reach a writer without this.
		await manager.ensureOnDisk();
		manager.appendMessage(assistant("seed"));

		const restoreWrites = failWrites();
		// Latch the failure while nobody is subscribed: the observer wired below
		// never runs at latch time, so print mode can only recover it from the
		// manager itself.
		manager.appendMessage({ role: "user", content: "pre-latch", timestamp: Date.now() } as never);

		const stderr = captureStderr();
		const session = assistantSession(manager, memoizingDispose(manager));

		let exitCode = -1;
		try {
			exitCode = await runPrintMode(session, { mode: "text" });
		} finally {
			stderr.restore();
			restoreWrites();
		}

		const reported = stderr
			.written()
			.split("\n")
			.filter(line => line.includes("Session persistence failed: "));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("ENOSPC");
		expect(exitCode).toBe(1);
	});

	it("settles a memoized dispose rejection instead of rethrowing it into the fatal handler", async () => {
		let call: Promise<void> | undefined;
		const dispose = (): Promise<void> => {
			call ??= Promise.resolve().then(() => {
				throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
			});
			return call;
		};
		const session = { dispose } as unknown as AgentSession;

		// The hazard: runRootCommand disposed a second time after print mode, and
		// the cached rejection escaped through main()'s fatal handler.
		await expect(session.dispose()).rejects.toThrow("ENOSPC");
		await expect(disposeSessionQuietly(session)).resolves.toBeUndefined();
	});

	it("replays a store failure latched before the RPC surface subscribed", async () => {
		const manager = makeSessionManager();
		await manager.ensureOnDisk();
		manager.appendMessage(assistant("seed"));

		const restoreWrites = failWrites();
		manager.appendMessage({ role: "user", content: "pre-latch", timestamp: Date.now() } as never);

		const notices: Array<{ level: string; message: string; source?: string }> = [];
		const stderr = captureStderr();
		try {
			registerRpcPersistenceSurface({
				sessionManager: manager,
				emitNotice: (level, message, source) => {
					notices.push({ level, message, source });
				},
			});
		} finally {
			stderr.restore();
			restoreWrites();
		}

		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("error");
		expect(notices[0]?.source).toBe("session-persistence");
		expect(notices[0]?.message).toContain("Session persistence failed: ");
		expect(notices[0]?.message).toContain("ENOSPC");
		expect(stderr.written()).toContain("ENOSPC");
	});
});
