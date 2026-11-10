import { parseStreamingJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import { getEnvApiKey } from "../env-api-key";
import { toDataUrl } from "../images/shared";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ServiceTier,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolChoice,
} from "../types";
import { OPENAI_MAX_OUTPUT_TOKENS, parseServiceTier } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { adaptSchemaForStrict, toolWireSchema } from "../utils/schema";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import { mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import { transportFetch } from "../utils/transport-fetch";
import type {
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "./openai-chat-wire";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export interface OpenAICompletionsOptions extends StreamOptions {
	reasoning?: string;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
	/** Request a standard JSON completion instead of SSE. */
	stream?: boolean;
	/** Explicit standard Chat Completions request fields. Routing fields are not accepted. */
	responseFormat?:
		| { type: "text" | "json_object" }
		| { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
	parallelToolCalls?: boolean;
}

function imagePart(image: ImageContent): ChatCompletionContentPart {
	const url = image.url || toDataUrl(image);
	const detail = image.detail === "original" ? "high" : image.detail;
	return { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } };
}
function inputParts(
	content: string | (TextContent | ImageContent)[],
	supportsImages: boolean,
): string | ChatCompletionContentPart[] {
	if (typeof content === "string") return content;
	return content.map(block =>
		block.type === "text"
			? { type: "text", text: block.text }
			: supportsImages
				? imagePart(block)
				: { type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
	);
}

export function convertMessages(model: Model<"openai-completions">, context: Context): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];
	for (const prompt of normalizeSystemPrompts(context.systemPrompt))
		messages.push({ role: "system", content: prompt });
	const supportsImages = model.input.includes("image");
	for (const message of transformMessages(context.messages, model)) {
		if (message.role === "assistant") {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("");
			const calls = message.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map(block => ({
					id: block.id,
					type: "function" as const,
					function: { name: block.name, arguments: JSON.stringify(block.arguments) },
				}));
			messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const images = message.content.filter((block): block is ImageContent => block.type === "image");
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: text || (images.length ? "Image output attached below." : ""),
			});
			if (images.length) messages.push({ role: "user", content: inputParts(images, supportsImages) });
		} else {
			messages.push({
				role:
					message.role === "developer" && model.compat?.supportsDeveloperRole !== true ? "system" : message.role,
				content: inputParts(message.content, supportsImages),
			});
		}
	}
	return messages;
}

export function convertTools(tools: Tool[], model?: Model<"openai-completions">): ChatCompletionTool[] {
	return tools.map(tool => {
		if (tool.native)
			throw new AIError.ConfigurationError("Provider-native tools are not supported by Chat Completions");
		const strict = tool.strict === true && model?.compat?.supportsStrictMode !== false;
		const parameters = adaptSchemaForStrict(toolWireSchema(tool), strict);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: parameters.schema,
				...(parameters.strict ? { strict: true } : {}),
			},
		};
	});
}

export function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions = {},
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: options.stream !== false,
	};
	if (body.stream && model.compat?.supportsUsageInStreaming !== false) body.stream_options = { include_usage: true };
	const maxTokens = Math.min(
		options.maxTokens ?? model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS,
		model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS,
		OPENAI_MAX_OUTPUT_TOKENS,
	);
	if (maxTokens > 0) body[model.compat?.maxTokensField ?? "max_completion_tokens"] = maxTokens;
	if (context.tools?.length) body.tools = convertTools(context.tools, model);
	const toolChoice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	if (toolChoice !== undefined) body.tool_choice = toolChoice;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.topP !== undefined) body.top_p = options.topP;
	if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
	if (options.stopSequences !== undefined) body.stop = options.stopSequences;
	if (options.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls;
	if (options.responseFormat !== undefined) body.response_format = options.responseFormat;
	if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
	if (options.reasoning && !options.disableReasoning && !options.forceReasoningOff)
		body.reasoning_effort = options.reasoning;
	if (options.disableReasoning || options.forceReasoningOff) body.reasoning_effort = "none";
	if (options.promptCacheKey) body.prompt_cache_key = options.promptCacheKey;
	if (model.compat?.supportsStore === true) body.store = false;
	return body;
}

export function isOpenAICompletionsProgressChunk(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const chunk = value as ChatCompletionChunk;
	return (
		!!chunk.usage ||
		!!chunk.error ||
		!!chunk.choices?.some(
			choice =>
				choice.finish_reason ||
				choice.message ||
				choice.delta?.content ||
				choice.delta?.refusal ||
				choice.delta?.tool_calls?.length,
		)
	);
}

function newMessage(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function assignUsage(
	output: AssistantMessage,
	usage: NonNullable<ChatCompletionChunk["usage"]>,
	model: Model<"openai-completions">,
): void {
	const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
	output.usage.input = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
	output.usage.cacheRead = cached;
	output.usage.output = usage.completion_tokens ?? 0;
	output.usage.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
	output.usage.totalTokens = usage.total_tokens ?? output.usage.input + cached + output.usage.output;
	const cost = output.usage.cost;
	cost.input = (output.usage.input * model.cost.input) / 1_000_000;
	cost.output = (output.usage.output * model.cost.output) / 1_000_000;
	cost.cacheRead = (cached * model.cost.cacheRead) / 1_000_000;
	cost.total = cost.input + cost.output + cost.cacheRead;
}

export function streamOpenAICompletions(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions = {},
): AssistantMessageEventStream {
	if (model.api !== "openai-completions")
		throw new AIError.ConfigurationError(`Unsupported API: ${model.api}. Only openai-completions is supported.`);
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const started = performance.now();
		const output = newMessage(model);
		const abortTracker = createAbortSourceTracker(options.signal);
		const signal = abortTracker.requestSignal;
		const tools = new Map<number, { block: ToolCall; contentIndex: number; json: string; ended: boolean }>();
		let text: { block: TextContent; contentIndex: number; ended: boolean } | undefined;
		let stopPreResponse = () => {};
		const endBlocks = () => {
			if (text && !text.ended) {
				text.ended = true;
				stream.push({
					type: "text_end",
					contentIndex: text.contentIndex,
					content: text.block.text,
					partial: output,
				});
			}
			for (const tool of tools.values())
				if (!tool.ended) {
					tool.ended = true;
					tool.block.arguments = parseToolCallArguments(tool.json);
					delete tool.block[kStreamingPartialJson];
					stream.push({
						type: "toolcall_end",
						contentIndex: tool.contentIndex,
						toolCall: tool.block,
						partial: output,
					});
				}
		};
		try {
			signal.throwIfAborted();
			if (!model.baseUrl) throw new AIError.ConfigurationError("Chat Completions requires an explicit baseUrl");
			const headers = new Headers(model.headers);
			const resolvedHeaders = await model.resolveHeaders?.(signal);
			for (const [key, value] of Object.entries(resolvedHeaders ?? {})) headers.set(key, value);
			const apiKey = options.apiKey ?? getEnvApiKey(model.provider);
			if (apiKey && apiKey !== NO_AUTH_SENTINEL && !headers.has("Authorization"))
				headers.set("Authorization", `Bearer ${apiKey}`);
			for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
			let body = buildParams(model, context, options);
			const edited = await options.onPayload?.(body, model, signal);
			if (edited !== undefined) {
				if (!edited || typeof edited !== "object" || Array.isArray(edited))
					throw new AIError.ValidationError("onPayload must return a JSON object");
				body = edited as Record<string, unknown>;
			}
			// Hooks may edit content, never choose another model or protocol route.
			body.model = model.id;
			const firstTimeout = options.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs();
			if (firstTimeout !== undefined && firstTimeout > 0) {
				const timer = setTimeout(
					() =>
						abortTracker.abortLocally(
							new AIError.StreamTimeoutError("Chat Completions timed out before the first response"),
						),
					firstTimeout,
				);
				timer.unref?.();
				stopPreResponse = () => clearTimeout(timer);
			}
			let sawDone = false;
			const handle = await postOpenAIStream<ChatCompletionChunk>({
				url: `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
				headers: Object.fromEntries(headers),
				body,
				signal,
				fetch: transportFetch(model, options.fetch, options.beforeDispatch),
				maxAttempts: options.maxHttpAttempts,
				onDoneSentinel: () => {
					sawDone = true;
				},
				onSseEvent: options.onSseEvent
					? event => options.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model)
					: undefined,
			});
			stopPreResponse();
			await notifyProviderResponse(options, handle.response, model, handle.requestId);
			output.credentialId = options.credentialId;
			stream.push({ type: "start", partial: output });
			let finished = false;
			const idleTimeout = options.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			for await (const chunk of iterateWithIdleTimeout(handle.events, {
				firstItemTimeoutMs: firstTimeout,
				idleTimeoutMs: idleTimeout,
				errorMessage: "Chat Completions stream stalled",
				isProgressItem: isOpenAICompletionsProgressChunk,
				abortSignal: signal,
				onIdle: () => abortTracker.abortLocally(new AIError.StreamTimeoutError("Chat Completions stream stalled")),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(
						new AIError.StreamTimeoutError("Chat Completions timed out before the first event"),
					),
			})) {
				if (chunk.error)
					throw new AIError.ProviderResponseError(chunk.error.message ?? "Chat Completions returned an error", {
						provider: model.provider,
					});
				if (chunk.id) output.responseId = chunk.id;
				if (chunk.model && chunk.model !== model.id) output.upstreamModel = chunk.model;
				const serviceTier = parseServiceTier(chunk.service_tier);
				if (serviceTier) output.serviceTier = serviceTier;
				if (chunk.usage) assignUsage(output, chunk.usage, model);
				const choice = chunk.choices?.find(value => value.index === 0 || value.index === undefined);
				if (!choice) continue;
				const delta = choice.delta ?? choice.message;
				if (delta) {
					const content = delta.content ?? delta.refusal;
					if (content) {
						if (!text) {
							const block: TextContent = { type: "text", text: "" };
							text = { block, contentIndex: output.content.length, ended: false };
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: text.contentIndex, partial: output });
						}
						text.block.text += content;
						stream.push({ type: "text_delta", contentIndex: text.contentIndex, delta: content, partial: output });
					}
					for (const [position, call] of (delta.tool_calls ?? []).entries()) {
						const index = call.index ?? position;
						let tool = tools.get(index);
						if (!tool) {
							const block: ToolCall = { type: "toolCall", id: call.id ?? "", name: "", arguments: {} };
							tool = { block, contentIndex: output.content.length, json: "", ended: false };
							tools.set(index, tool);
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: tool.contentIndex, partial: output });
						}
						if (call.id) tool.block.id = call.id;
						if (call.function?.name) tool.block.name += call.function.name;
						if (call.function?.arguments) {
							tool.json += call.function.arguments;
							tool.block[kStreamingPartialJson] = tool.json;
							tool.block.arguments = parseStreamingJson(tool.json);
							stream.push({
								type: "toolcall_delta",
								contentIndex: tool.contentIndex,
								delta: call.function.arguments,
								partial: output,
							});
						}
					}
					if (content || delta.tool_calls?.length) output.ttft ??= performance.now() - started;
				}
				if (choice.finish_reason) {
					finished = true;
					if (choice.finish_reason === "content_filter")
						throw new AIError.ProviderResponseError("Chat Completions response blocked by content filter", {
							provider: model.provider,
						});
					output.stopReason =
						choice.finish_reason === "length"
							? "length"
							: choice.finish_reason === "tool_calls"
								? "toolUse"
								: "stop";
				}
			}
			signal.throwIfAborted();
			if (!finished && !sawDone)
				throw new AIError.ProviderResponseError("Chat Completions stream ended before a terminal event", {
					provider: model.provider,
				});
			endBlocks();
			for (const tool of tools.values())
				if (!tool.block.id || !tool.block.name)
					throw new AIError.ProviderResponseError("Chat Completions returned a tool call without an id or name", {
						provider: model.provider,
					});
			if (tools.size && output.stopReason === "stop") output.stopReason = "toolUse";
			if (!output.content.length && !options.acceptEmptyResponse)
				throw new AIError.ProviderResponseError("Chat Completions returned an empty response", {
					provider: model.provider,
				});
			output.duration = performance.now() - started;
			stream.push({
				type: "done",
				reason: output.stopReason === "error" || output.stopReason === "aborted" ? "stop" : output.stopReason,
				message: output,
			});
		} catch (error) {
			endBlocks();
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				capturedErrorResponse: error instanceof OpenAIHttpError ? error.captured : undefined,
			});
			output.stopReason = result.stopReason;
			output.errorMessage = result.message;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.duration = performance.now() - started;
			stream.push({ type: "error", reason: result.stopReason, error: output });
		} finally {
			stopPreResponse();
			stream.end();
		}
	})();
	return stream;
}
