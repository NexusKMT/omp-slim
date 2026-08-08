import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
}

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const encoder = new TextEncoder();

async function runCell(code: string): Promise<RunnerFrame[]> {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const frames: RunnerFrame[] = [];

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				return JSON.parse(line) as RunnerFrame;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`Python runner exited before done frame: ${await stderr}`);
			pending += decoder.decode(value, { stream: true });
		}
	}

	try {
		proc.stdin.write(encoder.encode(`${JSON.stringify({ id: "r1", code })}\n`));
		proc.stdin.flush();
		while (true) {
			const frame = await readFrame();
			frames.push(frame);
			if (frame.type === "done") break;
		}
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		return frames;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released by stream closure.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

// A thread perpetually parked in a blocking `sys.stdin` read deadlocks native
// extension imports (NumPy) under a pipe-backed subprocess on Windows
// (numpy#24290, issue #7985). The runner must therefore never keep a
// concurrent control-channel reader alive while a cell (and its imports) run.
describe("Python runner stdin control channel", () => {
	it("has no background thread parked in a stdin read while a cell executes", async () => {
		const inspect = [
			"import sys, threading",
			"main_id = threading.main_thread().ident",
			"readers = []",
			"for th in threading.enumerate():",
			"    if th.ident == main_id:",
			"        continue",
			"    fr = sys._current_frames().get(th.ident)",
			"    names = []",
			"    while fr is not None:",
			"        names.append(fr.f_code.co_name)",
			"        fr = fr.f_back",
			'    if th.name == "omp-stdin-reader" or "_read_stdin" in names:',
			"        readers.append(th.name)",
			'print("STDIN_READERS=" + repr(sorted(readers)))',
		].join("\n");
		const frames = await runCell(inspect);
		const stdout = frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data)
			.join("");

		expect(stdout).toContain("STDIN_READERS=[]");
		expect(frames.at(-1)?.status).toBe("ok");
	});
});
