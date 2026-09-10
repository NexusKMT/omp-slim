/**
 * Contract (review 3983906393): when the session store fails while RPC mode is
 * shutting down, the client still receives the persistence `notice` frame and
 * the process exits nonzero with the loss mirrored on stderr — instead of the
 * dispose rejection escaping to the fatal handler and discarding the queued
 * frame.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("RPC shutdown on a failed session store", () => {
	it("drains the notice frame and exits nonzero instead of escaping to the fatal handler", async () => {
		const dir = TempDir.createSync("@pi-rpc-shutdown-");
		tempDirs.push(dir);
		const root = dir.path();
		// A session directory the process can read but not write: the first
		// persistence write fails with EACCES and the store latches the failure,
		// exactly as a full or unplugged disk would. A file-as-directory fails
		// earlier, in the plan-reference lookup, so it would never reach the store.
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });

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
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderrPromise = new Response(child.stderr).text();

		// The store rejects the write this frame triggers, the notice is queued on
		// the asynchronous `stdoutQueue`, and stdin EOF ends the process at once —
		// so the frame can only reach the client through the shutdown drain.
		child.stdin.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
		await child.stdin.flush();
		child.stdin.end();

		const notices: Record<string, unknown>[] = [];
		try {
			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (isRecord(frame) && frame.type === "notice") notices.push(frame);
			}
		} finally {
			child.kill();
			fs.chmodSync(sessionDir, 0o700);
		}

		const exitCode = await child.exited;
		const stderr = await stderrPromise;

		const persistenceNotice = notices.find(notice => notice.source === "session-persistence");
		expect(persistenceNotice?.level).toBe("error");
		expect(String(persistenceNotice?.message)).toContain("Session persistence failed: ");
		expect(exitCode).toBe(1);
		// The mode's own teardown claim is on stderr; the raw fatal dump the
		// review complains about never gets this far.
		expect(stderr).toContain("Session persistence is still failing at shutdown: ");
	}, 30_000);
});
