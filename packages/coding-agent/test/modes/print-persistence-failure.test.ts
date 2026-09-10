/**
 * Contract (issue #11493): a latched store failure reaches a headless consumer —
 * print mode reports it on stderr and returns a nonzero code, RPC mode emits a
 * `notice` — instead of escaping as a raw fatal dump or going unreported.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
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
});
