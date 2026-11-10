import { describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, TextContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { waitForDelayOrAbort } from "./helpers";

const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) {
		return init.signal;
	}
	if (input instanceof Request) {
		return input.signal;
	}
	return undefined;
}

function getRequestHeader(input: string | URL | Request, init: RequestInit | undefined, name: string): string | null {
	if (init?.headers) {
		return new Headers(init.headers).get(name);
	}
	if (input instanceof Request) {
		return input.headers.get(name);
	}
	return null;
}
function createHangingSseResponse(signal: AbortSignal | undefined, onCancel?: (reason: unknown) => void): Response {
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abortListener = () => {
				if (abortListener) {
					signal?.removeEventListener("abort", abortListener);
				}
				const reason = signal?.reason;
				if (reason instanceof Error) {
					controller.error(reason);
					return;
				}
				controller.error(new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
		},
		cancel(reason) {
			onCancel?.(reason);
			if (abortListener) {
				signal?.removeEventListener("abort", abortListener);
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createHangingFetch(): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return createHangingSseResponse(getRequestSignal(input, init));
	}

	return mockFetch as typeof fetch;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createNoProgressOpenAIResponsesStream(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encode({ type: "response.created", response: { id: "resp_stalled" } }));
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_stalled",
						call_id: "call_stalled",
						name: "todo",
						arguments: "",
						status: "in_progress",
					},
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.in_progress",
						response: { id: "resp_stalled", status: "in_progress" },
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createDelayedFetch(
	delayMs: number,
	responseFactory: () => Response,
	onRequest?: (input: string | URL | Request, init: RequestInit | undefined) => void,
): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		onRequest?.(input, init);
		await waitForDelayOrAbort(delayMs, getRequestSignal(input, init));
		return responseFactory();
	}

	return mockFetch as typeof fetch;
}

function createOpenAIResponsesSuccessResponse(): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_delayed" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_delayed", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello delayed" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_delayed",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello delayed" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_delayed",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					total_tokens: 7,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function createOpenAICompletionsSuccessResponse(modelId: string): Response {
	return createSseResponse([
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "Hello delayed" } }],
		},
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 2,
				total_tokens: 7,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		},
		"[DONE]",
	]);
}

function createOllamaChatSuccessResponse(): Response {
	return new Response(
		`${JSON.stringify({ message: { content: "Hello delayed" }, done: false })}\n${JSON.stringify({
			done: true,
			done_reason: "stop",
			prompt_eval_count: 5,
			eval_count: 2,
		})}\n`,
		{ status: 200 },
	);
}

async function expectFirstEventTimeout(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	expectedMessage: string,
): Promise<void> {
	const fetchMock = createHangingFetch();
	const result = await run(20, fetchMock);

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(expectedMessage);
}

async function expectRequestSetupTimeout(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	expectedMessage: string,
	responseFactory: () => Response,
): Promise<void> {
	const signals: AbortSignal[] = [];
	const fetchMock = createDelayedFetch(30, responseFactory, (input, init) => {
		const signal = getRequestSignal(input, init);
		if (signal) signals.push(signal);
	});

	const result = await run(20, fetchMock);

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(expectedMessage);
	expect(signals).toHaveLength(1);
	expect(signals[0]?.aborted).toBe(true);
}

async function expectCallerAbort(
	run: (
		signal: AbortSignal,
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	unexpectedMessage: string,
): Promise<void> {
	const fetchMock = createHangingFetch();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 5);

	const result = await run(controller.signal, 50, fetchMock);

	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).not.toBe(unexpectedMessage);
	expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
}

function getFirstTextContent(result: { content: unknown[] }): TextContent | undefined {
	return result.content.find((content): content is TextContent => {
		return typeof content === "object" && content !== null && "type" in content && content.type === "text";
	});
}

async function expectDelayedRequestSetupSucceeds(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; content: unknown[] }>,
	responseFactory: () => Response,
): Promise<void> {
	// The watchdog must cover request setup (connection + first byte). We simulate
	// a realistic ~30ms setup latency, but keep the budget far larger so the
	// scheduler jitter of a loaded CI box (where this stream races dozens of other
	// parallel test processes) can never trip the watchdog on a request that is
	// supposed to succeed. The complementary firing tests pin the budget < latency
	// case with their own short timeouts, so the contrast is preserved.
	const fetchMock = createDelayedFetch(30, responseFactory);
	const result = await run(5_000, fetchMock);

	expect(result.stopReason).toBe("stop");
	expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
}

describe("OpenAI-family first-event timeouts", () => {
	it("forwards streamSimple per-call first-event timeout to OpenAI completions", async () => {
		const fetchMock = createHangingFetch();
		const result = await streamSimple(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 20,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Chat Completions timed out before the first event");
	});

	it("surfaces the OpenAI completions first-event timeout message", async () => {
		await expectFirstEventTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Chat Completions timed out before the first event",
		);
	});
	it("times out OpenAI completions before the stream opens and forwards the budget to the SDK request", async () => {
		await expectRequestSetupTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Chat Completions timed out before the first response",
			() => createOpenAICompletionsSuccessResponse(openAICompletionsModel.id),
		);
	});

	it("cancels the OpenAI completions response body when the first-event watchdog fires", async () => {
		let cancelled = false;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createHangingSseResponse(undefined, () => {
					cancelled = true;
				}),
			);
		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 20,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Chat Completions timed out before the first event");
		expect(cancelled).toBe(true);
	});

	it("keeps caller aborts as aborted for OpenAI completions", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					signal,
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Chat Completions timed out before the first event",
		);
	});

	it("does not arm the first-event watchdog before OpenAI completions stream setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			() => createOpenAICompletionsSuccessResponse(openAICompletionsModel.id),
		);
	});

	it("disarms the completions first-event watchdog before onResponse runs", async () => {
		let releaseHook: (() => void) | undefined;
		vi.useFakeTimers();
		try {
			const hookEntered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			releaseHook = gate.resolve;
			const fetchMock: FetchImpl = () =>
				Promise.resolve(createOpenAICompletionsSuccessResponse(openAICompletionsModel.id));
			const resultPromise = streamOpenAICompletions(openAICompletionsModel, baseContext(), {
				apiKey: "test-key",
				streamFirstEventTimeoutMs: 20,
				fetch: fetchMock,
				onResponse: async () => {
					hookEntered.resolve();
					await gate.promise;
				},
			}).result();

			await hookEntered.promise;
			for (let i = 0; i < 10; i++) await Promise.resolve();
			// A still-armed timer would abort the connected body while the hook
			// below is parked; nothing else in this path arms a timer, so zero
			// here proves the headers-arrival disarm ran before the hook.
			expect(vi.getTimerCount()).toBe(0);
			releaseHook();
			const result = await resultPromise;
			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
		} finally {
			releaseHook?.();
			vi.useRealTimers();
		}
	});
});
