import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { resolveStdioSpawnCommand, StdioTransport, writeFrame } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import { trackUnhandled } from "./helpers/rejection";

describe("resolveStdioSpawnCommand", () => {
	it("passes argv through and detaches off macOS", () => {
		const config = { type: "stdio" as const, command: "codegraph", args: ["serve", "--mcp"] };

		const linux = resolveStdioSpawnCommand(config, { platform: "linux" });
		expect(linux.cmd).toEqual(["codegraph", "serve", "--mcp"]);
		expect(linux.detached).toBe(true);

		expect(resolveStdioSpawnCommand(config, { platform: "darwin" }).detached).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeFrame — the seam that catches synchronous FileSink throws AND neutralizes
// asynchronous (Promise) rejections, so the async `notify` / `#sendResponse` /
// `request` paths never let an un-awaited broken-pipe rejection escape as a fatal
// unhandled rejection. See issue #1710 and its async follow-up.
// ---------------------------------------------------------------------------

describe("writeFrame", () => {
	it("writes and flushes, returning true on success", () => {
		const sink = {
			writes: [] as string[],
			flushed: 0,
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, '{"k":1}\n')).toBe(true);
		expect(sink.writes).toEqual(['{"k":1}\n']);
		expect(sink.flushed).toBe(1);
	});

	it("returns false when write() throws synchronously (broken pipe)", () => {
		const sink = {
			flushed: 0,
			write() {
				throw new Error("EPIPE: broken pipe, write");
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.flushed).toBe(0);
	});

	it("returns false when flush() throws after a successful write", () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				throw new Error("EPIPE: broken pipe, flush");
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.writes).toEqual(["anything\n"]);
	});

	it("returns true and neutralizes an asynchronous write rejection (broken pipe surfaced as a Promise)", async () => {
		const sink = {
			flushed: 0,
			write() {
				return Promise.reject(new Error("EPIPE: broken pipe, write"));
			},
			flush() {
				this.flushed++;
			},
		};

		const tracker = trackUnhandled();
		try {
			// No synchronous throw, so the frame is "accepted"; the async rejection
			// must be neutralized rather than escaping as an unhandled rejection.
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("returns true and neutralizes an asynchronous flush rejection", async () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				return Promise.reject(new Error("EPIPE: broken pipe, flush"));
			},
		};

		const tracker = trackUnhandled();
		try {
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — end-to-end behavior against a real subprocess that
// exits before or while a notification is sent. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink observes a closed pipe.
//   2. A failed write tears the transport down (`onClose` fires) and surfaces
//      a rejection to the caller when the platform reports one synchronously.
//
// On platforms where the pipe accepts the write, read-loop EOF still closes the
// transport. The request/response parsing path is covered separately; this test
// intentionally avoids requiring subprocess stdout because Bun's test runner can
// hand stdout-writing child processes an unusable fd on some hosts.
// ---------------------------------------------------------------------------

describe("StdioTransport.notify", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("rejects synchronously when called before connect()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("rejects with 'Transport not connected' after close()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		await transport.connect();
		await transport.close();

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("does not surface unhandled rejections when the subprocess exits before notify settles", async () => {
		const tracker = trackUnhandled();
		const closed = Promise.withResolvers<void>();
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});
		transport.onClose = () => {
			closed.resolve();
		};

		try {
			await transport.connect();
			const notify = transport.notify("notifications/initialized").catch((error: unknown) => {
				expect(error).toBeInstanceOf(Error);
			});

			await closed.promise;
			await notify;
			await Promise.resolve();

			expect(tracker.capture()).toEqual([]);
			expect(transport.connected).toBe(false);
		} finally {
			tracker.release();
		}
	});
});

describe("StdioTransport request failure diagnostics", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("reports abrupt subprocess termination as EOF instead of a generic close", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => process.exit(23)); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			retryable: false,
		});
		expect(error.message).toContain("MCP subprocess");
	});

	it("reports malformed subprocess JSON at the decode stage", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => console.log('{not-json')); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "stdio",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});
});

describe("StdioTransport send acceptance", () => {
	let transport: StdioTransport | undefined;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await transport?.close();
		if (child?.exitCode === null) child.kill();
		await child?.exited;
		transport = undefined;
		child = undefined;
	});

	for (const { operation, asynchronous, retryable } of [
		{ operation: "write", asynchronous: false, retryable: true },
		{ operation: "write", asynchronous: true, retryable: false },
		{ operation: "flush", asynchronous: false, retryable: false },
		{ operation: "flush", asynchronous: true, retryable: false },
	] as const) {
		it(`${asynchronous ? "asynchronous" : "synchronous"} ${operation} failures are ${retryable ? "retryable before dispatch" : "not replayable after acceptance"}`, async () => {
			child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const spawn = vi.spyOn(Bun, "spawn").mockReturnValueOnce(child);
			transport = new StdioTransport({ type: "stdio", command: process.execPath, timeout: 100 });
			await transport.connect();
			spawn.mockRestore();
			const brokenPipe = Object.assign(new Error(`EPIPE: broken pipe, ${operation}`), { code: "EPIPE" });
			vi.spyOn(child.stdin, operation).mockImplementationOnce(() => {
				if (asynchronous) return Promise.reject(brokenPipe);
				throw brokenPipe;
			});

			await expect(transport.request("tools/list")).rejects.toMatchObject({
				transport: "stdio",
				stage: "send",
				failure: "eof",
				retryable,
				code: "EPIPE",
			});
		});
	}
});

// ---------------------------------------------------------------------------
// StdioTransport.close — authoritative resource teardown that must keep
// cleaning up the subprocess and read loop even when `#handleClose()` has
// already flipped `#connected` (read-loop EOF, or a notify() write failure
// in the connectToServer() failure path). See PR #1711 follow-up.
//
// Bun's parent-side stdout reader only sees EOF when the subprocess
// actually exits, so the "subprocess closed its stdout but stayed alive"
// state we'd love to test directly cannot be reproduced through a real
// subprocess on this platform. Instead we exercise the post-handleClose
// code path via the natural read-loop-EOF route and pair it with explicit
// idempotency checks; the reviewer-flagged leak surfaces on Windows where
// the notify() write actually throws.
// ---------------------------------------------------------------------------

describe("StdioTransport.close", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("completes cleanup when called after the read loop has already torn down", async () => {
		// Subprocess exits cleanly; the read loop sees EOF and fires
		// `#handleClose()`, flipping `#connected` to false. `close()` then
		// runs in exactly the state the reviewer flagged — `#connected`
		// already false, `#process` and `#readLoop` still set — and must
		// still null them out instead of early-returning.
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();

		// Wait for the read loop to observe EOF and fire #handleClose.
		for (let i = 0; i < 100 && transport.connected; i++) {
			await Bun.sleep(10);
		}
		expect(transport.connected).toBe(false);
		expect(closeCount).toBe(1);

		// Must not throw and must not re-fire onClose.
		await transport.close();
		expect(closeCount).toBe(1);

		// Second close is a no-op too — every resource is already released.
		await transport.close();
		expect(closeCount).toBe(1);
	});

	it("is idempotent — repeat close() calls fire onClose exactly once", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();
		await transport.close();
		await transport.close();
		await transport.close();

		expect(closeCount).toBe(1);
		expect(transport.connected).toBe(false);
	});

	// Regression for #5578: close() escalates SIGTERM to SIGKILL when the
	// subprocess ignores the former, so this must stay idempotent even when
	// the *first* close() had to run the full escalation path, not just the
	// already-covered "child exited before close()" and "child dies on plain
	// SIGTERM" cases above. POSIX-only: the child traps SIGTERM and must be
	// escalated to SIGKILL for the `elapsedMs >= 900` timing assertion below.
	it("is idempotent even when close() had to escalate to SIGKILL", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-close-escalate-"));
		const scriptPath = path.join(tempDir, "child.mjs");
		const readyPath = path.join(tempDir, "ready");
		try {
			await fs.writeFile(
				scriptPath,
				[
					"import { writeFileSync } from 'node:fs';",
					"process.on('SIGTERM', () => {});",
					`writeFileSync(${JSON.stringify(readyPath)}, '1');`,
					"setInterval(() => {}, 60_000);",
				].join("\n"),
			);
			transport = new StdioTransport({
				type: "stdio",
				command: "bun",
				args: ["run", scriptPath],
			});

			await transport.connect();

			// Wait for the child to actually register its SIGTERM handler before
			// closing: closing too early races the child's startup and hits the
			// default (terminate) action instead of exercising the escalation
			// path this test defends.
			for (let i = 0; i < 100; i++) {
				try {
					await fs.access(readyPath);
					break;
				} catch {
					await Bun.sleep(20);
				}
			}

			const started = performance.now();
			await transport.close();
			const elapsedMs = performance.now() - started;
			// Escalation only fires after the SIGTERM grace window elapses.
			expect(elapsedMs).toBeGreaterThanOrEqual(900);

			// Repeat close() calls must not throw or attempt to re-signal a
			// process the first call already tore down.
			await expect(transport.close()).resolves.toBeUndefined();
			await expect(transport.close()).resolves.toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 5000);
});
