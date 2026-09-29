import { isBedrockAnthropicRoute } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Api, Model, StreamOptions } from "../types";
import { extractClaudeMetadataSessionId } from "./anthropic-identity";
import { isBedrockRequestMetadataValue } from "./bedrock-request-metadata";

/**
 * Fit an Anthropic request body to Bedrock's `/anthropic` routes: both reject
 * the tool `strict` field, and bedrock-runtime rejects a `metadata.user_id`
 * outside Bedrock's request-metadata pattern. A user id that fits is kept,
 * otherwise its embedded session id, otherwise the metadata is dropped.
 */
function fitBedrockAnthropicPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isRecord(tool)) delete tool.strict;
		}
	}
	if (payload.metadata === undefined) return payload;
	const userId = isRecord(payload.metadata) ? payload.metadata.user_id : undefined;
	const fitted =
		typeof userId === "string" && isBedrockRequestMetadataValue(userId)
			? userId
			: extractClaudeMetadataSessionId(userId);
	if (fitted && isBedrockRequestMetadataValue(fitted)) payload.metadata = { user_id: fitted };
	else delete payload.metadata;
	return payload;
}

/**
 * Request hook for the `amazon-bedrock` and `bedrock-mantle` providers: an
 * `anthropic-messages` model on a Bedrock `/anthropic` route gets its request
 * body fitted after any caller `onPayload` hook, so a hook cannot restore a
 * field Bedrock rejects. Every other model passes through untouched.
 */
export function withBedrockAnthropicRequestShape(model: Model<Api>, options: StreamOptions): StreamOptions {
	if (model.api !== "anthropic-messages" || !isBedrockAnthropicRoute(model.baseUrl)) return options;
	const callerHook = options.onPayload;
	return {
		...options,
		onPayload: async (payload, hookModel, signal) =>
			fitBedrockAnthropicPayload((await callerHook?.(payload, hookModel, signal)) ?? payload),
	};
}
