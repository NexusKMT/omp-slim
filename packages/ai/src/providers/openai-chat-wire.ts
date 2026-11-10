/** Standard OpenAI Chat Completions request and response shapes used by this package. */
export interface ChatCompletionContentPartText {
	type: "text";
	text: string;
}
export interface ChatCompletionContentPartImage {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}
export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage;
export interface ChatCompletionMessageFunctionToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
export interface ChatCompletionMessageParam {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content: string | ChatCompletionContentPart[] | null;
	tool_calls?: ChatCompletionMessageFunctionToolCall[];
	tool_call_id?: string;
}
export type ChatCompletionAssistantMessageParam = ChatCompletionMessageParam;
export type ChatCompletionToolMessageParam = ChatCompletionMessageParam;
export interface ChatCompletionTool {
	type: "function";
	function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}
export interface ChatCompletionChunk {
	id?: string;
	model?: string;
	service_tier?: string;
	error?: { message?: string; code?: string | number; type?: string };
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
	choices?: {
		index?: number;
		finish_reason?: string | null;
		delta?: ChatCompletionDelta;
		message?: ChatCompletionDelta;
	}[];
}
export interface ChatCompletionDelta {
	role?: string;
	content?: string | null;
	refusal?: string | null;
	tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}
