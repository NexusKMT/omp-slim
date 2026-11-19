import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
let root: string;
let agentDir: string;
let server: Bun.Server<undefined>;
let requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
let rejectRequests: boolean;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slim-regressions-"));
	agentDir = path.join(root, "agent");
	requests = [];
	rejectRequests = false;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				url: new URL(request.url).pathname,
				headers: Object.fromEntries(request.headers),
				body: (await request.json()) as Record<string, unknown>,
			});
			if (rejectRequests)
				return Response.json(
					{ error: { message: "fixture endpoint rejected the request", type: "invalid_api_key" } },
					{ status: 401 },
				);
			return Response.json({
				id: "fixture",
				choices: [{ index: 0, message: { role: "assistant", content: "fixture response" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 12, completion_tokens: 3 },
			});
		},
	});
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					auth: "apiKey",
					apiKey: "fixture-key",
					headers: { "X-Tenant": "fixture ' $(literal)" },
					models: [
						{ id: "global" },
						{
							id: "selected/model",
							headers: { "x-tenant": "fixture ' $(literal)" },
							input: ["text", "image"],
							compat: { maxTokensField: "max_tokens" },
						},
					],
				},
			},
		}),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({ model: "local/global", lsp: { enabled: false } }),
	);
	await Bun.write(path.join(root, ".omp/config.yml"), JSON.stringify({ model: "local/selected/model" }));
});

afterEach(async () => {
	server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

async function child(command: string[], stdin?: string, env: Record<string, string | undefined> = {}) {
	const proc = Bun.spawn(command, {
		cwd: root,
		env: {
			...process.env,
			PI_CONFIG_DIR: path.join(root, "config"),
			PI_CODING_AGENT_DIR: agentDir,
			OMP_PROFILE: "",
			...env,
		},
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

describe("Slim configured-model regressions", () => {
	it("cleanse without --model reaches the configured project endpoint; an invalid override fails before HTTP", async () => {
		rejectRequests = true;
		const command = [
			process.execPath,
			path.join(repo, "packages/coding-agent/src/cli.ts"),
			"cleanse",
			"find a checker",
			"--agents",
			"1",
			"--all",
		];
		const result = await child(command);
		expect(result.code, result.stderr).toBe(1);
		expect(requests.length, result.stdout + result.stderr).toBeGreaterThan(0);
		expect(
			requests.every(request => request.url === "/v1/chat/completions" && request.body.model === "selected/model"),
		).toBe(true);
		requests = [];
		const invalid = await child([...command, "--model", "local/missing"]);
		expect(invalid.code).toBe(1);
		expect(invalid.stdout + invalid.stderr).toContain('Model "local/missing" is not configured');
		expect(requests).toEqual([]);
	}, 30_000);

	it("audit reads only the selected agent directory", async () => {
		const transcript = [
			{ type: "session", id: "isolated-session", cwd: "/fixture/project", timestamp: new Date().toISOString() },
			{
				type: "message",
				message: {
					role: "assistant",
					timestamp: Date.now(),
					model: "fixture",
					content: [{ type: "text", text: "done" }],
					usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
				},
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n");
		await Bun.write(path.join(agentDir, "sessions/fixture/isolated-session.jsonl"), transcript);
		const output = path.join(root, "audit.json");
		const result = await child([
			process.execPath,
			path.join(repo, "scripts/session-stats/audit.ts"),
			"--no-llm",
			"--json",
			output,
		]);
		expect(result.code, result.stderr).toBe(0);
		const audit = await Bun.file(output).json();
		expect(audit.sessions).toHaveLength(1);
		expect(JSON.stringify(audit.sessions[0])).toContain("isolated-session");
		expect(requests).toEqual([]);
	});
});
