import type { Api, ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions">): boolean {
	if (!model.input.includes("image")) return false;
	if (model.compat.stripImageInput) return false;
	return true;
}

/**
 * Whether the transport that will carry `model` sends image content on the wire.
 *
 * Only the OpenAI Chat Completions path applies the text-only guard; every other
 * API ships the modalities the model declares. Callers that report or gate on
 * image capability (e.g. the `omp models` table) must read this instead of
 * `model.input` alone, or they advertise support the wire silently strips.
 */
export function supportsImageInput(model: Model<Api>): boolean {
	if (!isOpenAICompletionsModel(model)) return model.input.includes("image");
	return isOpenAICompletionsVisionSupported(model);
}

/** Narrows the model union to the one API the text-only guard belongs to. */
function isOpenAICompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
	return model.api === "openai-completions";
}
