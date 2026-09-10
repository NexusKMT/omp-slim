/**
 * Contract (review 3983906393): a store failure latched while RPC mode shuts
 * down must still reach the client. The notice is queued on the asynchronous
 * `stdoutQueue`, so the process has to drain that queue before it exits;
 * otherwise the frames go with the process and the client sees a clean exit for
 * a run whose transcript never became durable.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

// chmod 0o500 and mkfifo are POSIX-only, and this test needs both.
describe.skipIf(process.platform === "win32")("RPC shutdown on a failed session store", () => {
	it("drains the queued notice before exiting on a persistence failure", async () => {
		const dir = TempDir.createSync("@pi-rpc-shutdown-");
		tempDirs.push(dir);
		const root = dir.path();
		// A session directory the process can read but not write: the first
		// persistence write fails with EACCES and the store latches the failure,
		// exactly as a full or unplugged disk would.
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });

		// A FIFO, not a pipe: Bun buffers a pipe's megabytes in userspace, so the
		// child never blocks on stdout and an undrained queue is invisible. The
		// FIFO's 64 KiB kernel buffer is the backpressure this contract is about.
		const fifoPath = path.join(root, "stdout.fifo");
		Bun.spawnSync(["mkfifo", fifoPath]);
		const fifo = fs.openSync(fifoPath, fs.constants.O_RDWR);

		try {
			const packageRoot = path.join(import.meta.dir, "..", "..");
			const child = Bun.spawn(
				[
					"bun",
					path.join(packageRoot, "src", "cli.ts"),
					"--mode",
					"rpc",
					"--session-dir",
					sessionDir,
					"--no-extensions",
					"--no-skills",
					"--no-rules",
				],
				{
					cwd: packageRoot,
					env: {
						...Bun.env,
						ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
						PI_NO_TITLE: "1",
						NO_COLOR: "1",
						XDG_DATA_HOME: root,
						XDG_CONFIG_HOME: root,
						PI_CODING_AGENT_DIR: agentDir,
					},
					stdin: "pipe",
					stdout: fifo,
					stderr: "pipe",
				},
			);
			const stderrPromise = new Response(child.stderr).text();

			// Queue a backlog the parent deliberately does not read, then fail the
			// store behind it, so the notice frame is still queued at shutdown.
			const frames: string[] = [];
			for (let index = 0; index < 400; index++) {
				frames.push(JSON.stringify({ id: `page-${index}`, type: "get_available_commands" }));
			}
			frames.push(JSON.stringify({ id: "boom", type: "new_session" }));
			child.stdin.write(`${frames.join("\n")}\n`);
			await child.stdin.flush();
			child.stdin.end();

			// Deliberate stall, not a duration guess: the condition under test is
			// that the child keeps the process alive for its queued frames, and a
			// process that decides not to has no event to await.
			const exitedWhileQueued = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(2_000).then(() => false),
			]);

			const decoder = new TextDecoder();
			const readBuffer = Buffer.alloc(64 * 1024);
			// Wall-clock ceiling on the drain, so a child that never finishes
			// writing fails the assertions instead of hanging the test file.
			const drainDeadline = Date.now() + 20_000;
			let output = "";
			for (;;) {
				let read = -1;
				try {
					read = fs.readSync(fifo, readBuffer, 0, readBuffer.length, null);
				} catch {
					read = -1; // EAGAIN: the FIFO buffer is empty
				}
				if (read > 0) {
					output += decoder.decode(readBuffer.subarray(0, read));
					continue;
				}
				if (child.exitCode !== null) break;
				if (Date.now() > drainDeadline) {
					child.kill();
					break;
				}
				await Bun.sleep(2);
			}
			const exitCode = await child.exited;
			const stderr = await stderrPromise;

			// Without the drain the child exits here with the queued frames still
			// undelivered, so nothing below can pass.
			expect(exitedWhileQueued).toBe(false);
			expect(exitCode).toBe(1);

			let notice: Record<string, unknown> | undefined;
			for (const line of output.split("\n")) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (isRecord(parsed) && parsed.type === "notice" && parsed.source === "session-persistence") {
					notice = parsed;
					break;
				}
			}
			expect(notice?.level).toBe("error");
			expect(String(notice?.message)).toContain("Session persistence failed: ");
			// The mode's own teardown claim is on stderr; the raw fatal dump the
			// review complains about never gets this far.
			expect(stderr).toContain("Session persistence is still failing at shutdown: ");
		} finally {
			fs.closeSync(fifo);
			fs.chmodSync(sessionDir, 0o700);
		}
	}, 30_000);
});
