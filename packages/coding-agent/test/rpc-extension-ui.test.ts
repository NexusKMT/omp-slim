import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type PendingExtensionRequest,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcInput,
	requestRpcSelect,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
}

function respond(pendingRequests: Map<string, PendingExtensionRequest>, id: string, payload: object): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, ...payload } as RpcExtensionUIResponse);
}

const dbQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
	recommended: 1,
};
const featuresQuestion: ExtensionAskDialogQuestion = {
	id: "features",
	question: "Which features?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
	multi: true,
};

/**
 * Scripted model: a user message ending in ask arguments as JSON becomes an ask call (omp may prepend
 * context to the first user message); a tool result ends the turn.
 */
function scriptedAskProvider(baseUrl: string): string {
	return `
export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: ${JSON.stringify(baseUrl)},
		api: "openai-completions",
		auth: "none",
		models: [{
			id: "ask",
			name: "Scripted ask",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
	});
}
`;
}

describe("RPC extension UI", () => {
	it("keeps extension dialogs headless while tool selections round-trip", async () => {
		await using temp = await TempDir.create("@rpc-headless-tool-ui-");
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
let extensionState;
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.on("session_start", async (_event, ctx) => {
      const confirmed = await ctx.ui.confirm("Extension confirm", "Must not reach the host");
      ctx.ui.notify("Extension notification");
      extensionState = { hasUI: ctx.hasUI, confirmed };
    });
  }],
});
await runRpcMode(session, {
  headless: true,
  setToolUIContext(ui, hasUI) {
    void ui.select("Tool choice", ["Keep", "Deploy"]).then(selected => {
      ui.notify(JSON.stringify({ toolHasUI: hasUI, selected, extension: extensionState }));
    });
  },
});
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const stderr = new Response(child.stderr).text();
		const requests: Record<string, unknown>[] = [];
		let result: unknown;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame) || frame.type !== "extension_ui_request") continue;
				requests.push(frame);
				if (frame.method === "select") {
					child.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Deploy" })}\n`,
					);
					await child.stdin.flush();
				} else if (frame.method === "notify") {
					if (typeof frame.message === "string") result = JSON.parse(frame.message);
					break;
				} else {
					throw new Error(`Unexpected extension UI: ${JSON.stringify(frame)}`);
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(result, await stderr).toEqual({
			toolHasUI: true,
			selected: "Deploy",
			extension: { hasUI: false, confirmed: false },
		});
		expect(requests.map(frame => frame.method)).toEqual(["select", "notify"]);
		expect(requests[0]).toMatchObject({ title: "Tool choice", options: ["Keep", "Deploy"] });
	}, 30_000);

	/** Spawns an RPC runtime whose extension awaits a `confirm` in `session_start` and has a `/probe` command. */
	async function spawnStartupDialogRuntime(temp: TempDir) {
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.registerCommand("probe", {
      // A command's context is built per call, so it sees whether set_ask_dialog took effect.
      handler: async (_args, ctx) => ctx.ui.notify("askDialog:" + typeof ctx.ui.askDialog),
    });
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(String(await ctx.ui.confirm("Trust?", "startup")));
    });
  }],
});
await runRpcMode(session);
`,
		);
		return Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
	}

	it("answers a dialog session_start awaits, running commands sent meanwhile only after startup, in order", async () => {
		await using temp = await TempDir.create("@rpc-startup-dialog-");
		const child = await spawnStartupDialogRuntime(temp);
		const stderr = new Response(child.stderr).text();
		const seen: string[] = [];
		let confirmId: unknown;
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "extension_ui_request" && frame.method === "confirm") {
				confirmId = frame.id;
				// Held until startup finishes (had one run at once, its response would precede the confirm's
				// notify) and then run in arrival order. set_ask_dialog is served during startup and takes effect.
				for (const id of ["s1", "s2"]) child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "p", type: "prompt", message: "/probe" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "s3", type: "get_state" })}\n`);
				child.stdin.write(`${JSON.stringify({ id: "ask", type: "set_ask_dialog", enabled: true })}\n`);
				await child.stdin.flush();
			} else if (frame.type === "response" && frame.id === "ask") {
				seen.push("ask");
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirmId, confirmed: true })}\n`);
				await child.stdin.flush();
			} else if (frame.type === "extension_ui_request" && frame.method === "notify") {
				seen.push(String(frame.message));
			} else if (frame.type === "response" && typeof frame.id === "string" && /^(s\d|p)$/.test(frame.id)) {
				seen.push(`${frame.id}:${frame.success}`);
				// Drain stdout to its end: closing the reader early would break the child's output pipe.
				if (frame.id === "s3") child.stdin.end();
			}
		}
		await child.exited;
		// The probe's own frames race the later state responses; every other frame's order is fixed.
		expect(
			seen.filter(entry => entry !== "p:true" && entry !== "askDialog:function"),
			await stderr,
		).toEqual(["ask", "true", "s1:true", "s2:true", "s3:true"]);
		expect(seen).toContain("askDialog:function");
	}, 30_000);

	it("rejects a dialog session_start awaits when stdin closes, so the process still exits", async () => {
		await using temp = await TempDir.create("@rpc-startup-dialog-eof-");
		const child = await spawnStartupDialogRuntime(temp);
		const stderr = new Response(child.stderr).text();
		// Read to the end of stdout: closing it early would fail the child's output, not exercise the EOF.
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (isRecord(frame) && frame.type === "extension_ui_request" && frame.method === "confirm") child.stdin.end();
		}
		const exitCode = await child.exited;
		expect({ exitCode, signal: child.signalCode }, await stderr).toEqual({ exitCode: 0, signal: null });
	}, 30_000);

	it("keeps the label-only wire shape for bare options", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", ["Keep", "Deploy"]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy"],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Keep" });
		expect(await result).toBe("Keep");
	});

	it("emits aligned descriptions and resolves with the selected label", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", [
			"Keep",
			{ label: "Deploy", description: " Push to production " },
			{ label: "Preview", description: "   " },
		]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy", "Preview"],
			optionDetails: [{}, { description: "Push to production" }, {}],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Deploy" });
		expect(await result).toBe("Deploy");
	});

	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("emits secret in extension_ui_request when dialogOptions.secret is provided", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();

		// 1. undefined secret: omitted from wire payload
		const unmaskedResult = requestRpcInput(pendingRequests, output, "Username", "e.g. alice");
		const unmaskedRequest = output.mock.calls[0]?.[0];
		expect(unmaskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "Username",
			placeholder: "e.g. alice",
		});
		expect(unmaskedRequest).not.toHaveProperty("secret");
		respond(pendingRequests, requireRequest(unmaskedRequest).id, { value: "alice" });
		await unmaskedResult;

		// 2. secret: true: included in wire payload as secret: true
		const maskedResult = requestRpcInput(pendingRequests, output, "API Key", undefined, { secret: true });
		const maskedRequest = output.mock.calls[1]?.[0];
		expect(maskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "API Key",
			secret: true,
		});
		respond(pendingRequests, requireRequest(maskedRequest).id, { value: "secret-token" });
		await maskedResult;

		// 3. secret: false: explicitly passed as secret: false
		const explicitUnmaskedResult = requestRpcInput(pendingRequests, output, "Public Note", undefined, {
			secret: false,
		});
		const explicitUnmaskedRequest = output.mock.calls[2]?.[0];
		expect(explicitUnmaskedRequest).toMatchObject({
			type: "extension_ui_request",
			method: "input",
			title: "Public Note",
			secret: false,
		});
		respond(pendingRequests, requireRequest(explicitUnmaskedRequest).id, { value: "hello" });
		await explicitUnmaskedResult;
	});

});

describe("RPC ask dialog", () => {
	it("sends every question in one ask frame and returns the validated answers", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions: [dbQuestion, featuresQuestion],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, {
			answers: [
				{ id: "db", selectedOptions: ["Postgres"], customInput: "   " },
				{ id: "features", selectedOptions: ["Search", "Auth"], customInput: "  Export  " },
			],
		});
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Search", "Auth"],
					customInput: "Export",
				},
			],
		});
	});

	const validDb = { id: "db", selectedOptions: ["Postgres"] };
	const validFeatures = { id: "features", selectedOptions: ["Auth"] };
	it.each([
		["too few answers", [validDb]],
		["answers out of question order", [validFeatures, validDb]],
		["an unknown option label", [{ id: "db", selectedOptions: ["MySQL"] }, validFeatures]],
		["a duplicated option", [validDb, { id: "features", selectedOptions: ["Auth", "Auth"] }]],
		["two options on a single-select", [{ id: "db", selectedOptions: ["Postgres", "SQLite"] }, validFeatures]],
		[
			"an option plus custom input on a single-select",
			[{ id: "db", selectedOptions: ["Postgres"], customInput: "DuckDB" }, validFeatures],
		],
	])("rejects %s", async (_case, answers) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { answers });

		await expect(result).rejects.toThrow(Error);
		expect(pendingRequests.size).toBe(0);
	});

	it.each([
		["omp's timer fires", 5, undefined],
		["the host reports its own timeout", undefined, { cancelled: true, timedOut: true }],
	])("answers every question with its recommended option when %s", async (_case, timeout, response) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion], {
			timeout,
			onTimeout,
		});
		if (response) respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, response);

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["SQLite"],
					customInput: undefined,
					timedOut: true,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Auth"],
					customInput: undefined,
					timedOut: true,
				},
			],
		});
		expect(onTimeout).toHaveBeenCalledTimes(1);
		// omp settled the dialog; only its own timer must tell the host to close it.
		const request = requireRequest(output.mock.calls[0]?.[0]);
		const cancels = output.mock.calls
			.map(([frame]) => frame)
			.filter(frame => "method" in frame && frame.method === "cancel");
		expect(cancels).toEqual(
			timeout === undefined ? [] : [expect.objectContaining({ method: "cancel", targetId: request.id })],
		);
	});

	it("resolves a plain host cancel as a cancelled dialog", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion], { onTimeout });

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { cancelled: true });

		expect(await result).toBeUndefined();
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("walks the ask tool's form through select prompts, also after the host opts into ask dialogs", async () => {
		await using temp = await TempDir.create("@rpc-ask-dialog-");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/models")) {
					return Response.json({ object: "list", data: [{ id: "ask", object: "model", owned_by: "scripted" }] });
				}
				if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
				const body = (await request.json()) as {
					messages?: { role?: string; content?: unknown }[];
					stream?: boolean;
				};
				const messages = body.messages ?? [];
				const last = messages.at(-1);
				const messageText = (content: unknown): string => {
					if (typeof content === "string") return content;
					if (!Array.isArray(content)) return "";
					return content
						.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
						.join("");
				};
				let reply: { text: string } | { tool: string; args: Record<string, unknown> };
				if (last?.role === "tool") {
					reply = { text: "done" };
				} else {
					const text = messageText(last?.content);
					const argsAt = text.indexOf('{"html"');
					reply =
						argsAt >= 0
							? { tool: "ask", args: JSON.parse(text.slice(argsAt)) as Record<string, unknown> }
							: { text: "done" };
				}
				const base = { id: "chatcmpl-ask", object: "chat.completion.chunk", created: 0, model: "ask" };
				const finish = "text" in reply ? "stop" : "tool_calls";
				const delta =
					"text" in reply
						? { role: "assistant", content: reply.text }
						: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call_ask",
										type: "function",
										function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
									},
								],
							};
				if (!body.stream) {
					const message =
						"text" in reply
							? { role: "assistant", content: reply.text }
							: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call_ask",
											type: "function",
											function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
										},
									],
								};
					return Response.json({
						id: "chatcmpl-ask",
						object: "chat.completion",
						created: 0,
						model: "ask",
						choices: [{ index: 0, message, finish_reason: finish }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					});
				}
				const events = [
					{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
					{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
				].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
				return new Response(`${events.join("")}data: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const extensionPath = temp.join("scripted-ask.ts");
		await Bun.write(extensionPath, scriptedAskProvider(server.url.origin + "/v1"));
		await Bun.write(
			path.join(temp.join("agent"), "models.yml"),
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false }],
					},
				},
			}),
		);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc-ui",
				"--no-session",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC ask fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const selectRequests: Record<string, unknown>[] = [];
		const askRequests: Record<string, unknown>[] = [];
		const toolResults: unknown[] = [];
		let optInResponse: unknown;
		let finished = false;
		const form = JSON.stringify({
			html: '<form><p>Which database?</p><label><input type="radio" name="db" value="pg"> Postgres</label><label><input type="radio" name="db" value="sqlite" checked> SQLite</label></form>',
		});

		try {
			// The provider exists only once the extension loads, so select it over RPC.
			await send({ type: "set_model", id: "model", provider: "scripted", modelId: "ask" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					await send({ type: "prompt", id: "fallback", message: form });
				} else if (frame.type === "extension_ui_request" && frame.method === "select") {
					selectRequests.push(frame);
					await send({ type: "extension_ui_response", id: frame.id, value: "Postgres" });
				} else if (frame.type === "extension_ui_request" && frame.method === "ask") {
					askRequests.push(frame);
					await send({ type: "extension_ui_response", id: frame.id, cancelled: true });
				} else if (frame.type === "tool_execution_end" && frame.toolName === "ask") {
					toolResults.push(frame.result);
				} else if (frame.type === "prompt_result" && frame.id === "fallback") {
					await send({ type: "set_ask_dialog", id: "opt-in", enabled: true });
				} else if (frame.type === "response" && frame.id === "opt-in") {
					optInResponse = frame;
					await send({ type: "prompt", id: "dialog", message: form });
				} else if (frame.type === "prompt_result" && frame.id === "dialog") {
					finished = true;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
			server.stop(true);
		}

		if (!finished) throw new Error(`RPC ask fixture did not finish: ${await stderr}`);
		await stderr;
		expect(selectRequests).toHaveLength(2);
		expect(selectRequests[0]).toMatchObject({ method: "select", title: "Which database?" });
		expect(optInResponse).toEqual({
			id: "opt-in",
			type: "response",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: true },
		});
		expect(askRequests).toEqual([]);
		const answered = expect.objectContaining({
			details: { answers: [{ name: "db", question: "Which database?", answer: "Postgres" }] },
		});
		expect(toolResults).toEqual([answered, answered]);
	}, 60_000);
});
