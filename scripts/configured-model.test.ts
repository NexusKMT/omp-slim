import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { resolveConfiguredScriptModel } from "./configured-model";

let root: string;
let agentDir: string;
const servers: Bun.Server<undefined>[] = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-script-model-"));
	agentDir = path.join(root, "agent");
});

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

async function configure(settings: Record<string, unknown>, providers: Record<string, unknown>): Promise<void> {
	await Bun.write(path.join(agentDir, "config.yml"), JSON.stringify(settings));
	await Bun.write(path.join(agentDir, "models.yml"), JSON.stringify({ providers }));
}

describe("maintenance script model selection", () => {
	it("uses project selection and configured request headers, and honors an explicit model override", async () => {
		const requests: { model: unknown; authorization: string | null; tenant: string | null; pathname: string }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model: unknown };
				requests.push({
					model: body.model,
					authorization: request.headers.get("authorization"),
					tenant: request.headers.get("x-tenant"),
					pathname: new URL(request.url).pathname,
				});
				return new Response(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		servers.push(server);
		await configure(
			{ model: "gateway/global" },
			{
				gateway: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					apiKey: "!printf '%s' 'fixture-key'",
					headers: { "X-Tenant": "fixture-tenant" },
					models: [{ id: "global" }, { id: "project" }],
				},
				local: { baseUrl: `http://127.0.0.1:${server.port}/local`, auth: "none", models: [{ id: "offline" }] },
			},
		);
		await Bun.write(path.join(root, ".omp/config.yml"), JSON.stringify({ model: "gateway/project" }));
		for (const selector of [undefined, "local/offline"]) {
			const configured = await resolveConfiguredScriptModel(selector, { cwd: root, agentDir });
			const response = await completeSimple(
				configured.model,
				{
					messages: [{ role: "user", content: "test", timestamp: 0 }],
				},
				{ apiKey: configured.apiKey },
			);
			expect(response.stopReason).toBe("stop");
		}
		expect(requests).toEqual([
			{
				model: "project",
				authorization: "Bearer fixture-key",
				tenant: "fixture-tenant",
				pathname: "/v1/chat/completions",
			},
			{ model: "offline", authorization: null, tenant: null, pathname: "/local/chat/completions" },
		]);
	});

	it("rejects an unavailable selected model while another configured endpoint exists", async () => {
		await configure(
			{ model: "gateway/removed" },
			{
				gateway: { baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "available" }] },
			},
		);
		await expect(resolveConfiguredScriptModel(undefined, { cwd: root, agentDir })).rejects.toThrow(/not configured/);
	});

	it("excludes a disabled provider when selecting the first available configured model", async () => {
		await configure(
			{ disabledProviders: ["disabled"] },
			{
				disabled: { baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "first" }] },
				local: { baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "allowed" }] },
			},
		);
		const configured = await resolveConfiguredScriptModel(undefined, { cwd: root, agentDir });
		expect(`${configured.model.provider}/${configured.model.id}`).toBe("local/allowed");
		await expect(resolveConfiguredScriptModel("disabled/first", { cwd: root, agentDir })).rejects.toThrow(/disabled/);
	});

	it("surfaces invalid protocol configuration and missing credentials before sending a request", async () => {
		await configure(
			{},
			{
				gateway: { baseUrl: "http://127.0.0.1:1/v1", api: "retired-protocol", models: [{ id: "chat" }] },
			},
		);
		await expect(resolveConfiguredScriptModel(undefined, { cwd: root, agentDir })).rejects.toThrow(
			/openai-completions/,
		);
		await configure(
			{ model: "missing-test-key/chat" },
			{
				"missing-test-key": { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "chat" }] },
			},
		);
		await expect(resolveConfiguredScriptModel(undefined, { cwd: root, agentDir })).rejects.toThrow(/No API key/);
	});
});
