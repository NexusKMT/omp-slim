import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

async function expectRpcOwnsStdin(): Promise<void> {
	const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
	const extensionPath = path.join(import.meta.dir, "fixtures", "locked-stdin-reader.ts");
	// The slim catalog ships no bundled models, so give the spawned CLI a
	// minimal openai-completions provider in a throwaway agent dir.
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-stdin-"));
	fs.writeFileSync(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  acme:",
			'    baseUrl: "https://example.invalid/v1"',
			'    api: "openai-completions"',
			'    apiKey: "test-key"',
			"    models:",
			'      - id: "acme-model"',
			"",
		].join("\n"),
		{ encoding: "utf-8" },
	);
	const child = Bun.spawn(
		["bun", cliPath, "--extension", extensionPath, "--mode", "rpc", "--provider", "acme", "--model", "acme-model"],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1", PI_CODING_AGENT_DIR: agentDir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();

	child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
	await child.stdin.flush();

	let stateResponse: Record<string, unknown> | undefined;
	try {
		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (isRecord(frame) && frame.type === "response" && frame.id === "probe") {
				stateResponse = frame;
				break;
			}
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});
		fs.rmSync(agentDir, { recursive: true, force: true });
	}

	const stderr = await stderrPromise;
	// The adversarial fixture is EXPECTED to fail loading — RPC claimed stdin
	// first — and its surfaced load notice (#4954) mentions the locked stream.
	// Any OTHER "ReadableStream is locked" line means RPC lost stdin ownership.
	for (const line of stderr.split("\n").filter(l => l.includes("ReadableStream is locked"))) {
		expect(line).toContain("Failed to load extension");
	}
	expect(stateResponse?.success).toBe(true);
}

// rpc-ui shares this exact pre-discovery claim path (`rpc || rpc-ui`) in main;
// a second full CLI startup would exercise no distinct ownership behavior.
describe("RPC mode stdin ownership", () => {
	test("claims stdin before extensions can lock its singleton stream", () => expectRpcOwnsStdin(), 30000);
});
