import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../../src/eval/bridge-timeout";
import {
	type CompletionAttempt,
	EVAL_HANDLE_CONCURRENCY,
	getCompletionHandle,
	releaseCompletionHandles,
	runEvalCompletion,
	type EvalCompletionBridgeOptions,
	type EvalCompletionResult,
} from "../../src/eval/completion-bridge";
import { type EvalHandleSnapshot, runEvalCancel, runEvalStatus, runEvalWait } from "../../src/eval/handle-bridge";
import { IdleTimeout } from "../../src/eval/idle-timeout";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeAllKernelSessions, type PythonResult } from "../../src/eval/py/executor";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { CostGate } from "../../src/session/cost-gate";
import { rejectionOf } from "../helpers/rejection";

async function runEvalCompletionAndWait(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const handle = await runEvalCompletion(args, options);
	const entry = getCompletionHandle(handle.id);
	if (!entry) throw new Error(`Missing completion handle ${handle.id}`);
	const waited = await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, options);
	const snapshot = waited.items[0];
	if (snapshot?.status === "failed" || snapshot?.status === "cancelled") {
		throw new ToolError(snapshot.error || `Completion handle ${handle.id} failed`);
	}
	if (entry.error) throw new ToolError(entry.error);
	if (!entry.result) throw new Error(`Completion handle ${handle.id} returned no result`);
	return entry.result;
}

/** Waits for a completion, then reads its attempt log through `__status__`. */
async function waitWithAttempts(
	args: unknown,
	session: ToolSession,
): Promise<{ snapshot?: EvalHandleSnapshot; attempts?: CompletionAttempt[] }> {
	const { id } = await runEvalCompletion(args, { session });
	const waited = await runEvalWait({ items: [{ kind: "completion", id }] }, { session });
	return {
		snapshot: waited.items[0],
		attempts: runEvalStatus({ item: { kind: "completion", id } }, { session }).attempts,
	};
}

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

const DEFAULT = makeModel("p", "default");

interface SessionOptions {
	available?: Model<Api>[];
	cwd?: string;
	apiKey?: string | null;
	activeModel?: string;
}

function makeSession(opts: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false });
	const available = opts.available ?? [DEFAULT];
	const modelRegistry = {
		getAvailable: () => available,
		find: (provider: string, id: string) => available.find(model => model.provider === provider && model.id === id),
		getApiKey: async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
		resolver: () => async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
	} as unknown as ModelRegistry;
	return {
		cwd: opts.cwd ?? process.cwd(),
		settings,
		modelRegistry,
		getActiveModel: () =>
			available.find(model => `${model.provider}/${model.id}` === (opts.activeModel ?? "p/default")),
	} as unknown as ToolSession;
}

function assistant(opts: {
	text?: string;
	toolCall?: { name: string; arguments: Record<string, unknown> };
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) {
		content.push({ type: "toolCall", id: "tc-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "p",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

async function runPythonCompletionsInSubprocess(tempDir: TempDir): Promise<PythonResult> {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const scriptPath = path.join(tempDir.path(), "run-python-completion.ts");
	const resultPath = path.join(tempDir.path(), "python-completion-result.json");
	const aiPath = path.resolve(import.meta.dir, "../../../ai/src/index.ts");
	const executorPath = path.resolve(import.meta.dir, "../../src/eval/py/executor.ts");
	const settingsPath = path.resolve(import.meta.dir, "../../src/config/settings.ts");
	const code = [
		"import json",
		'plain_handle = completion("hi")',
		"plain = plain_handle.wait()",
		// `await` resolves on a worker thread; it must keep the cell's run context.
		'structured = await completion("hi", schema={"type": "object"})',
		'print(json.dumps({"plain": plain, "attempts": plain_handle.attempts, "structured": structured}))',
	].join("\n");
	await Bun.write(
		scriptPath,
		`
import { vi } from "bun:test";
import * as ai from ${JSON.stringify(aiPath)};
import { executePython } from ${JSON.stringify(executorPath)};
import { Settings } from ${JSON.stringify(settingsPath)};

const DEFAULT = {
	id: "default",
	name: "default",
	api: "openai-responses",
	provider: "p",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const settings = Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false });
const session = {
	cwd: ${JSON.stringify(tempDir.path())},
	settings,
	modelRegistry: {
		getAvailable: () => [DEFAULT],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	},
	getActiveModel: () => DEFAULT,
};
vi.spyOn(ai, "completeSimple")
	.mockResolvedValueOnce({
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "text", text: "hello from python" }],
	})
	.mockResolvedValueOnce({
		role: "assistant",
		api: "openai-responses",
		provider: "p",
		model: "smol",
		stopReason: "stop",
		content: [{ type: "toolCall", id: "tc-1", name: "respond", arguments: { ok: true } }],
	});
const result = await executePython(${JSON.stringify(code)}, {
	cwd: ${JSON.stringify(tempDir.path())},
	sessionId: "py-completion",
	sessionFile: ${JSON.stringify(path.join(tempDir.path(), "session.jsonl"))},
	toolSession: session,
	kernelMode: "per-call",
});
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
process.exit(0);
`,
	);
	const child = await $`bun ${scriptPath}`.cwd(repoRoot).quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0)
		throw new Error(stderr || stdout || `Python completion subprocess exited with ${child.exitCode}`);
	return (await Bun.file(resultPath).json()) as PythonResult;
}

describe("runEvalCompletion", () => {
	it("uses the current model object without consulting model roles or discovering alternatives", async () => {
		const current = makeModel("p", "selected", { baseUrl: "https://selected.example/v1" });
		const session = makeSession({ available: [DEFAULT, current], activeModel: "p/selected" });
		const registry = session.modelRegistry!;
		const available = vi.spyOn(registry, "getAvailable").mockImplementation(() => {
			throw new Error("unexpected discovery");
		});
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletionAndWait({ prompt: "q" }, { session });
		expect(spy.mock.calls[0]?.[0]).toBe(current);
		expect(spy.mock.calls[0]?.[2]?.disableServerSideFallback).toBe(true);
		expect(available).not.toHaveBeenCalled();
	});

	it("does not try another model after the current model fails", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("current model unavailable"));
		const session = makeSession({ available: [DEFAULT, makeModel("p", "backup")] });
		await expect(runEvalCompletionAndWait({ prompt: "q" }, { session })).rejects.toThrow("current model unavailable");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(DEFAULT);
	});

	it("rejects every retired model selector before starting a model request", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		for (const model of ["default", "smol", "slow", "p/other"]) {
			await expect(runEvalCompletion({ prompt: "q", model }, { session: makeSession() })).rejects.toThrow(
				"model overrides are not supported",
			);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("does not discover a model when the session has no current model", async () => {
		await expect(
			runEvalCompletion({ prompt: "q" }, { session: makeSession({ activeModel: "missing" }) }),
		).rejects.toThrow("no current session model");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		releaseCompletionHandles("Main");
	});

	it("counts each completion against the session's cost cap and refuses at it", async () => {
		const billed = assistant({ text: "ok" });
		billed.usage.cost.total = 1.2;
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(billed);
		const costGate = new CostGate(Settings.isolated({ "session.maxCost": 1 }), 0, () => {});
		const session = { ...makeSession(), costGate } as ToolSession;

		await runEvalCompletionAndWait({ prompt: "q" }, { session });
		expect(costGate.spent).toBe(1.2);
		const refused = await rejectionOf(runEvalCompletionAndWait({ prompt: "q" }, { session }));
		expect(String(refused)).toContain("Cost cap reached");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("forwards the session id to the API key lookup", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession();
		session.getSessionId = () => "sess-1";
		const seen: unknown[][] = [];
		const registry = session.modelRegistry;
		if (!registry) throw new Error("test requires a model registry");
		registry.getApiKey = async (model, sessionId, options) => {
			seen.push([model, sessionId, options]);
			return "test-key";
		};

		await runEvalCompletionAndWait({ prompt: "q" }, { session });

		expect(seen.length).toBe(1);
		expect(seen[0]?.[1]).toBe("sess-1");
	});

	it("returns the completion text in plain mode", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "the answer" }));
		const result = await runEvalCompletionAndWait({ prompt: "q" }, { session: makeSession() });
		expect(result.text).toBe("the answer");
		expect(result.details).toEqual({ model: "p/default", structured: false });
	});

	it("supplies a non-empty systemPrompt when system is omitted (codex 'Instructions are required' guard)", async () => {
		// The openai-codex Responses transformer drops `instructions` when no
		// system prompt is provided, and the remote endpoint then 400s with
		// "Instructions are required". runEvalCompletion must always carry a non-empty
		// systemPrompt so `completion("…")` without a `system` argument works.
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletionAndWait({ prompt: "q" }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toBeDefined();
		expect(ctx.systemPrompt?.length).toBeGreaterThan(0);
		expect(ctx.systemPrompt?.[0]).toMatch(/.+/);
	});

	it("honors an explicit system prompt instead of overriding it", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletionAndWait({ prompt: "q", system: "Be terse." }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toEqual(["Be terse."]);
	});

	it("forces a respond tool call and returns its arguments in structured mode", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { answer: 42 } } }));
		const result = await runEvalCompletionAndWait(
			{ prompt: "q", schema: { type: "object", properties: { answer: { type: "number" } } } },
			{ session: makeSession() },
		);

		expect(JSON.parse(result.text)).toEqual({ answer: 42 });
		expect(result.details.structured).toBe(true);

		const ctx = spy.mock.calls[0]?.[1] as { tools?: Array<{ name: string }> };
		const opts = spy.mock.calls[0]?.[2] as { toolChoice?: unknown };
		expect(ctx.tools?.[0]?.name).toBe("respond");
		expect(opts.toolChoice).toEqual({ type: "tool", name: "respond" });
	});

	it("falls back to JSON embedded in text when the model skips the respond tool", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: 'here: {"answer": 7}' }));
		const result = await runEvalCompletionAndWait(
			{ prompt: "q", schema: { type: "object" } },
			{ session: makeSession() },
		);
		expect(JSON.parse(result.text)).toEqual({ answer: 7 });
	});

	it("throws ToolError on invalid arguments", async () => {
		await expect(runEvalCompletionAndWait({ prompt: "" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
		await expect(
			runEvalCompletionAndWait({ prompt: "q", model: "huge" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when the resolved model has no API key", async () => {
		const session = makeSession({ apiKey: null });
		await expect(runEvalCompletionAndWait({ prompt: "q" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("maps error and aborted stop reasons to ToolError", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "boom" }));
		await expect(runEvalCompletionAndWait({ prompt: "q" }, { session: makeSession() })).rejects.toThrow("boom");

		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "aborted" }));
		await expect(runEvalCompletionAndWait({ prompt: "q" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("throws ToolError when plain mode produces no text", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "" }));
		await expect(runEvalCompletionAndWait({ prompt: "q" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("marks the answering attempt failed when its output is unusable", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "not json" }));
		const { attempts } = await waitWithAttempts({ prompt: "q", schema: { type: "object" } }, makeSession());
		expect(attempts).toEqual([
			{
				model: "p/default",
				effort: null,
				outcome: "failed",
				error: "completion() did not return a structured response matching the schema.",
			},
		]);
	});

	it("reports a running attempt live and marks it cancelled on cancel", async () => {
		const started = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			started.resolve();
			const signal = options?.signal;
			if (!signal) throw new Error("completion request did not receive an abort signal");
			const aborted = Promise.withResolvers<never>();
			signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
			return await aborted.promise;
		});
		const session = makeSession();
		const item = {
			kind: "completion" as const,
			id: (await runEvalCompletion({ prompt: "q" }, { session })).id,
		};
		await started.promise;
		expect(runEvalStatus({ item }, { session }).attempts?.map(attempt => attempt.outcome)).toEqual(["running"]);

		runEvalCancel({ item }, { session });
		await runEvalWait({ items: [item] }, { session });
		expect(runEvalStatus({ item }, { session }).attempts?.map(attempt => attempt.outcome)).toEqual(["cancelled"]);
	});

	it("bounds in-flight handles and admits queued ones as earlier requests settle", async () => {
		const total = EVAL_HANDLE_CONCURRENCY + 8;
		const gate = Promise.withResolvers<void>();
		let inFlight = 0;
		let peak = 0;
		const admitted = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			if (inFlight === EVAL_HANDLE_CONCURRENCY) admitted.resolve();
			await gate.promise;
			inFlight--;
			return assistant({ text: "ok" });
		});
		const session = makeSession();

		const handles = await Promise.all(
			Array.from({ length: total }, () => runEvalCompletion({ prompt: "q" }, { session })),
		);
		await admitted.promise;
		expect(peak).toBe(EVAL_HANDLE_CONCURRENCY);
		gate.resolve();
		const waited = await runEvalWait(
			{ items: handles.map(handle => ({ kind: "completion", id: handle.id })) },
			{ session },
		);

		expect(waited.items.map(item => item.status)).toEqual(Array(total).fill("completed"));
		expect(peak).toBe(EVAL_HANDLE_CONCURRENCY);
	});

	it("pauses the idle watchdog while a slow completion() request is in flight", async () => {
		vi.useFakeTimers();
		try {
			// A oneshot completion emits no status until it returns; delegated model
			// time must be invisible to the eval timeout budget.
			const started = Promise.withResolvers<void>();
			vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
				started.resolve();
				await Bun.sleep(200);
				return assistant({ text: "the answer" });
			});

			const ops: string[] = [];
			using idle = new IdleTimeout(60);
			const pendingResult = runEvalCompletionAndWait(
				{ prompt: "q" },
				{
					session: makeSession(),
					signal: idle.signal,
					emitStatus: event => {
						ops.push(event.op);
						if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
						if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
					},
				},
			);
			await started.promise;
			vi.advanceTimersByTime(200);
			const result = await pendingResult;

			expect(result.text).toBe("the answer");
			expect(ops).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
			expect(idle.signal.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("completion() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		releaseCompletionHandles("Main");
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes plain and structured completion() in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-js-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistant({ text: "hello from smol" }))
			.mockResolvedValueOnce(assistant({ toolCall: { name: "respond", arguments: { ok: true, n: 3 } } }));

		const result = await executeJs(
			[
				'const handles = [completion("hi"), completion("hi", { schema: { type: "object" } })];',
				"const [plain, structured] = await wait(handles);",
				"return JSON.stringify({ plain, structured, attempts: await handles[0].attempts() });",
			].join("\n"),
			{ cwd: tempDir.path(), sessionId, session: makeSession({ cwd: tempDir.path() }), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({
			plain: "hello from smol",
			structured: { ok: true, n: 3 },
			attempts: [{ model: "p/default", effort: null, outcome: "succeeded" }],
		});
	});

	it("waits for a completion started in an earlier JavaScript cell", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-cells-");
		const options = {
			cwd: tempDir.path(),
			sessionId: `js-completion-cells:${crypto.randomUUID()}`,
			session: makeSession({ cwd: tempDir.path() }),
			sessionFile: path.join(tempDir.path(), "session.jsonl"),
		};
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "hello from the next cell" }));

		const started = await executeJs('var handles = [completion("hi")]; print("started");', options);
		expect(started.exitCode).toBe(0);
		expect(started.output.trim()).toBe("started");

		const result = await executeJs("print((await wait(handles))[0]);", options);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello from the next cell");
	});

	it("times out waiting on a running completion started in an earlier JavaScript cell", async () => {
		using tempDir = TempDir.createSync("@omp-eval-completion-cells-timeout-");
		const options = {
			cwd: tempDir.path(),
			sessionId: `js-completion-cells-timeout:${crypto.randomUUID()}`,
			session: makeSession({ cwd: tempDir.path() }),
			sessionFile: path.join(tempDir.path(), "session.jsonl"),
		};
		// The model call stays running until afterEach releases (aborts) the handle.
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, opts) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
			return promise;
		});

		const started = await executeJs('var handles = [completion("hi")];', options);
		expect(started.exitCode).toBe(0);

		// Real clock: the timeout is enforced by the host `__wait__` bridge across the worker boundary.
		const result = await executeJs(
			"try { await wait(handles, { timeout: 0.05 }); } catch (error) { print(error.name); }",
			options,
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("TimeoutError");
	});

	it("exposes plain and structured completion() in the Python runtime", async () => {
		const tempDir = TempDir.createSync("@omp-eval-completion-py-");
		try {
			const result = await runPythonCompletionsInSubprocess(tempDir);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual({
				plain: "hello from python",
				structured: { ok: true },
				attempts: [{ model: "p/default", effort: null, outcome: "succeeded" }],
			});
		} finally {
			tempDir.removeSync();
		}
	});
});
