import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
let root: string;
let agentDir: string;
let server: Bun.Server<undefined>;
let requests: { model: unknown; authorization: string | null }[];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-maintenance-models-"));
	agentDir = path.join(root, "agent");
	requests = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/runs/run/traces/trace") {
				return Response.json({
					jobName: "run",
					trace: "trace",
					totalEvents: 1,
					entries: [{ kind: "assistant", model: "historical/model", text: "Fixed a file.", tools: [] }],
				});
			}
			if (url.pathname === "/api/runs/run") return new Response(null, { status: 404 });
			if (url.pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
			const body = (await request.json()) as {
				model: unknown;
				stream: boolean;
				tools?: { function: { name: string } }[];
			};
			requests.push({ model: body.model, authorization: request.headers.get("authorization") });
			if (!body.stream) {
				return Response.json({
					choices: [
						{
							index: 0,
							finish_reason: "stop",
							message: {
								role: "assistant",
								content: JSON.stringify({ items: [{ id: 0, text: "Read `file` before editing." }] }),
							},
						},
					],
				});
			}
			const toolName = body.tools?.[0]?.function.name;
			const delta = toolName
				? {
						tool_calls: [
							{
								index: 0,
								id: "call-1",
								type: "function",
								function: {
									name: toolName,
									arguments: JSON.stringify({
										sections: [{ category: "Fixed", items: ["Fixed the configured endpoint."] }],
									}),
								},
							},
						],
					}
				: { content: "Completed the requested analysis." };
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: toolName ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await Bun.write(path.join(agentDir, "config.yml"), "model: gateway/selected\n");
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					apiKey: "fixture-key",
					models: [{ id: "selected" }],
				},
			},
		}),
	);
});

afterEach(async () => {
	server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

async function runScript(script: string, args: string[]): Promise<string> {
	const proc = Bun.spawn([process.execPath, path.join(repoRoot, script), ...args], {
		cwd: root,
		env: { ...process.env, PI_CONFIG_DIR: path.join(root, "config"), PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

describe("maintenance commands with a configured Chat Completions endpoint", () => {
	it("rewrites a prompt through the configured model and preserves inline code", async () => {
		const input = path.join(root, "prompt.md");
		const output = path.join(root, "rewritten.md");
		await Bun.write(input, "Please read `file` before you edit it.\n");
		await runScript("scripts/rewrite-system-prompt.ts", ["-i", input, "-o", output, "--retries", "0"]);
		expect(await Bun.file(output).text()).toBe("Read `file` before editing.\n");
		expect(requests).toEqual([{ model: "selected", authorization: "Bearer fixture-key" }]);
	});

	it("rewrites a changelog through the configured model without the retired auth broker", async () => {
		const changelog = path.join(root, "packages/example/CHANGELOG.md");
		await Bun.write(changelog, "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Updated endpoint plumbing.\n");
		await runScript("scripts/rewrite-changelog.ts", ["--repo-root", root]);
		expect(await Bun.file(changelog).text()).toContain("- Fixed the configured endpoint.");
		expect(requests).toEqual([{ model: "selected", authorization: "Bearer fixture-key" }]);
	});

	it("runs the prompt probe with the selected model and the requested sample count", async () => {
		const stdout = await runScript(".omp/skills/tool-prompt-optimization/scripts/probe.ts", [
			"--schema",
			"{}",
			"--template",
			"Describe a tool.",
			"--samples",
			"2",
			"--json",
		]);
		const result = JSON.parse(stdout) as { results: { model: string; samples: { text: string }[] }[] };
		expect(result.results).toMatchObject([
			{
				model: "gateway/selected",
				samples: [{ text: "Completed the requested analysis." }, { text: "Completed the requested analysis." }],
			},
		]);
		expect(requests).toEqual([
			{ model: "selected", authorization: "Bearer fixture-key" },
			{ model: "selected", authorization: "Bearer fixture-key" },
		]);
	});
});
