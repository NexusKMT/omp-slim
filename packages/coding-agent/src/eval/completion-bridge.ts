/**
 * Host-side handler for the eval `completion()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_COMPLETION_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `completion(prompt, opts)`, the prelude forwards `{ prompt, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */

import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import { formatModelString, formatModelStringWithRouting } from "../config/model-resolver";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { Semaphore } from "../task/parallel";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `completion()` helper across both runtimes. */
export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

const completionArgsSchema = type({
	prompt: "string>0",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Terminal payload of a retained handle. */
export interface EvalCompletionResult {
	text: string;
	/** Structured payload; when present the cell receives it in place of `text`. */
	data?: unknown;
	details: { model: string; structured: boolean };
}

/** Handle returned immediately after an eval completion starts. */
export interface EvalCompletionHandleResult {
	id: string;
}

/** The current model request recorded by a completion handle. */
export interface CompletionAttempt {
	/** `provider/id[@upstream]`. */
	model: string;
	/** Reasoning effort sent; `"off"` disables reasoning, `null` leaves the provider default. */
	effort: Effort | "off" | null;
	outcome: "running" | "no-credentials" | "succeeded" | "failed" | "cancelled";
	error?: string;
}

/** Process-local state retained for one eval completion handle. */
export interface CompletionHandleEntry {
	ownerId: string;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	result?: EvalCompletionResult;
	error?: string;
	attempts: CompletionAttempt[];
	evictionTimer?: NodeJS.Timeout;
}

const COMPLETION_HANDLE_RETENTION_MS = 30 * 60 * 1000;
const completionHandles = new Map<string, CompletionHandleEntry>();

/**
 * Process-wide ceiling on eval model requests executing at once, shared by
 * `completion()` handles, `judge()`, and `judge_batch()` items. A cell that
 * fans out hundreds of calls otherwise opens every request simultaneously,
 * including on hosts that serve requests serially. Queued handles
 * report `running` until admitted.
 */
export const EVAL_HANDLE_CONCURRENCY = 32;
export const evalRequestSlots = new Semaphore(EVAL_HANDLE_CONCURRENCY);

/** Resolve a retained completion handle by id. */
export function getCompletionHandle(id: string): CompletionHandleEntry | undefined {
	return completionHandles.get(id);
}

/** Cancel and remove every completion handle owned by an agent session. */
export function releaseCompletionHandles(ownerId: string): void {
	for (const [id, entry] of completionHandles) {
		if (entry.ownerId !== ownerId) continue;
		entry.controller.abort(new ToolError("Completion handle owner released"));
		clearTimeout(entry.evictionTimer);
		completionHandles.delete(id);
	}
}

async function executeCompletion(
	prompt: string,
	system: string | undefined,
	schema: Record<string, unknown> | undefined,
	model: Model<Api>,
	session: ToolSession,
	signal: AbortSignal,
	attempts: CompletionAttempt[],
): Promise<EvalCompletionResult> {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("completion() has no model registry.");

	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];
	const refusal = session.costGate?.check();
	if (refusal) throw new ToolError(refusal.message);
	const attempt: CompletionAttempt = {
		model: formatModelStringWithRouting(model),
		effort: null,
		outcome: "running",
	};
	attempts.push(attempt);
	let response: AssistantMessage;
	try {
		const sessionId = session.getSessionId?.() ?? undefined;
		if (!(await registry.getApiKey(model, sessionId, { signal }))) {
			attempt.outcome = "no-credentials";
			throw new ToolError(`completion() has no API key for current model ${formatModelString(model)}.`);
		}
		response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: registry.resolver(model, sessionId),
				disableServerSideFallback: true,
				signal,
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
			},
			{ telemetry, oneshotKind: "eval_completion" },
		);
		session.costGate?.record(response.usage.cost.total);
		if (response.stopReason === "aborted") throw new ToolError("completion() request aborted.");
		if (response.stopReason === "error") throw new ToolError(response.errorMessage ?? "completion() request failed.");
	} catch (error) {
		if (attempt.outcome !== "no-credentials") failAttempt(attempt, error, signal);
		throw error;
	}

	let resultText: string;
	try {
		resultText = responseText(response, schema);
	} catch (error) {
		failAttempt(attempt, error, signal);
		throw error;
	}
	attempt.outcome = "succeeded";
	return {
		text: resultText,
		details: { model: formatModelString(model), structured: Boolean(schema) },
	};
}

function failAttempt(attempt: CompletionAttempt, error: unknown, signal: AbortSignal): void {
	attempt.outcome = signal.aborted ? "cancelled" : "failed";
	attempt.error = error instanceof Error ? error.message : String(error);
}

function responseText(response: AssistantMessage, schema: Record<string, unknown> | undefined): string {
	if (!schema) {
		const text = extractTextContent(response);
		if (!text) throw new ToolError("completion() returned no text output.");
		return text;
	}
	const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
	if (call) return JSON.stringify(call.arguments);
	const text = extractTextContent(response);
	if (!text) throw new ToolError("completion() returned no structured response.");
	try {
		return JSON.stringify(parseJsonPayload(text));
	} catch {
		throw new ToolError("completion() did not return a structured response matching the schema.");
	}
}

/** Start a stateless completion and return its process-local handle immediately. */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionHandleResult> {
	if (isRecord(args) && Object.hasOwn(args, "model")) {
		throw new ToolError("completion() uses the current session model; model overrides are not supported.");
	}
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, system, schema } = parsed;
	const model = options.session.getActiveModel?.();
	if (!model) throw new ToolError("completion() has no current session model.");

	return retainCompletionHandle("cmp", options, (signal, attempts) =>
		executeCompletion(prompt, system, schema, model, options.session, signal, attempts),
	);
}

/**
 * Run `execute` in the background under a session-owned, cancellable handle
 * and return its id immediately; `wait()`/`status()`/`cancel()` resolve it
 * through {@link getCompletionHandle}. Settled entries are evicted after
 * {@link COMPLETION_HANDLE_RETENTION_MS}.
 */
export function retainCompletionHandle(
	prefix: string,
	options: EvalCompletionBridgeOptions,
	execute: (signal: AbortSignal, attempts: CompletionAttempt[]) => Promise<EvalCompletionResult>,
): EvalCompletionHandleResult {
	const id = `${prefix}-${Snowflake.next()}`;
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const entry: CompletionHandleEntry = {
		ownerId,
		controller,
		promise: Promise.resolve(),
		settled: false,
		attempts: [],
	};
	completionHandles.set(id, entry);
	const run = async (): Promise<EvalCompletionResult> => {
		await evalRequestSlots.acquire(signal);
		try {
			return await execute(signal, entry.attempts);
		} finally {
			evalRequestSlots.release();
		}
	};
	entry.promise = run()
		.then(
			result => {
				entry.result = result;
			},
			error => {
				entry.error = error instanceof Error ? error.message : String(error);
			},
		)
		.finally(() => {
			entry.settled = true;
			const timer = setTimeout(() => {
				if (completionHandles.get(id) === entry) completionHandles.delete(id);
			}, COMPLETION_HANDLE_RETENTION_MS);
			timer.unref?.();
			entry.evictionTimer = timer;
		});
	return { id };
}
