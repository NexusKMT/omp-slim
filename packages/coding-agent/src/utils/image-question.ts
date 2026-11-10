import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { type Api, type AssistantMessage, completeSimple, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import imageQuestionSystemPromptTemplate from "../prompts/tools/image-question-system.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { LoadedImageInput } from "./image-loading";

import { cfgImagesBlockImages } from "../modes/settings";
import { cfgImagesQuestionTimeoutMs } from "../tools/settings";

/** Vision-capable model selected for an explicit image question. */
export interface ResolvedImageQuestionModel {
	model: Model<Api>;
}

/** Text and accounting returned by one explicit image question. */
export interface ImageQuestionResult {
	text: string;
	model: string;
	usage: Usage;
}

/** Explicit image questions use the current model, with no vision role or model fallback. */
export function resolveImageQuestionModel(session: ToolSession): ResolvedImageQuestionModel {
	const model = session.getActiveModel?.();
	if (!model) throw new ToolError("No current session model is selected for image questions.");
	if (!sendsImageInputOnWire(model)) {
		throw new ToolError(
			`Current model ${model.provider}/${model.id} does not support image input. Select a primary model that supports images to analyze this file.`,
		);
	}
	return { model };
}

/** Ask the resolved vision model a question about an already-loaded image. */
export async function askImageQuestion(
	session: ToolSession,
	resolved: ResolvedImageQuestionModel,
	image: LoadedImageInput,
	question: string,
	signal: AbortSignal | undefined,
	completeImpl: typeof completeSimple = completeSimple,
): Promise<ImageQuestionResult> {
	if (cfgImagesBlockImages.get(session.settings)) {
		throw new ToolError(
			"Image submission is disabled by settings (images.blockImages=true). Disable it to ask about images.",
		);
	}

	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new ToolError("Model registry is unavailable for image questions.");
	}
	const current = resolveImageQuestionModel(session).model;
	if (resolved.model !== current)
		throw new ToolError("The current model changed before the image question started; retry the read.");
	const model = current;
	const sessionId = session.getSessionId?.() ?? undefined;
	const apiKey = await modelRegistry.getApiKey(model, sessionId, { signal });
	if (!apiKey) {
		throw new ToolError(
			`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
		);
	}

	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const timeoutMs = cfgImagesQuestionTimeoutMs.get(session.settings);
	const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
	const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
	const effectiveSignal = timeoutSignal ? (signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal) : signal;
	const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
	const formatTimeoutMessage = (): string => {
		const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
		return `Image question timed out after ${seconds}s. Increase images.questionTimeoutMs (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`;
	};

	session.costGate?.admit();
	let response: AssistantMessage;
	try {
		response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [prompt.render(imageQuestionSystemPromptTemplate)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: image.data, mimeType: image.mimeType },
							{ type: "text", text: question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: modelRegistry.resolver(model, session.getSessionId?.() ?? undefined),
				disableServerSideFallback: true,
				signal: effectiveSignal,
			},
			{ telemetry, oneshotKind: "image_question", completeImpl },
		);
		session.costGate?.record(response.usage.cost.total);
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
		}
		throw error;
	}

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "Image question request failed.");
	}
	if (response.stopReason === "aborted") {
		if (timedOut()) throw new ToolError(formatTimeoutMessage());
		throw new ToolError("Image question request aborted.");
	}

	const text = extractTextContent(response);
	if (!text) {
		throw new ToolError("Vision model returned no text output.");
	}

	return {
		text,
		model: `${model.provider}/${model.id}`,
		usage: response.usage,
	};
}
