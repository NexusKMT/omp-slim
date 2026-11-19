import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Context,
	type Model,
	type OneshotRetryOptions,
	retryTransientCompletion,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

/**
 * Options accepted by {@link completeSimpleWithRetry}. Keeps the injection and
 * retry seams of the former telemetry-instrumented wrapper without any
 * OpenTelemetry machinery.
 */
export interface CompleteOneshotOptions {
	/**
	 * Override for the underlying {@link completeSimple} call. Use to retain a
	 * test injection seam.
	 */
	readonly completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/**
	 * Opt in to transient-failure retry for this oneshot (Anthropic
	 * `overloaded_error`, `rate_limit_error`, 429/500/502/503/529). Omitted or
	 * `undefined` means **no retry** — the failure is surfaced exactly as
	 * before.
	 *
	 * Deliberately opt-in rather than default-on: re-issuing is only safe when
	 * the call performs no side effect and nothing consumed partial output —
	 * true for summaries, titles, handoffs and image descriptions, which parse
	 * a complete response after it resolves.
	 *
	 * Pass `{}` to accept the {@link retryTransientCompletion} defaults
	 * (3 attempts, 500ms base backoff, `retry-after` honored).
	 */
	readonly retry?: OneshotRetryOptions;
}

/**
 * Wrap a {@link completeSimple} round-trip with transient-failure retry.
 *
 * `getResponseHeaders` hands the failed attempt's headers to the retry layer —
 * an AssistantMessage carries none, so this is what makes `retry-after` on a
 * real 429/529 actually honored.
 */
export async function completeSimpleWithRetry<TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions & { onAttempt?: (message: AssistantMessage) => void },
	oneshot: CompleteOneshotOptions = {},
): Promise<AssistantMessage> {
	// Wrap the user-supplied onResponse so we always capture response headers
	// for the retry layer without stealing them from the caller.
	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = options.onResponse;
	const captureOnResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};
	const complete = oneshot.completeImpl ?? completeSimple;
	const runOnce = (): Promise<AssistantMessage> => {
		// Clear first so a previous attempt's `retry-after` can never be reused
		// for a later failure that arrived without headers.
		capturedHeaders = undefined;
		return complete(model, ctx, { ...options, onResponse: captureOnResponse });
	};
	return oneshot.retry
		? retryTransientCompletion(runOnce, {
				...oneshot.retry,
				provider: model.provider,
				// Framework-owned: the caller must not be able to detach the abort
				// signal or the header source by passing them itself.
				signal: options.signal,
				getResponseHeaders: () => capturedHeaders,
			})
		: runOnce();
}
