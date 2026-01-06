import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import geminiImageDescription from "../../prompts/tools/gemini-image.md" with { type: "text" };
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime";
import type { CustomTool } from "../custom-tools/types";
import { untilAborted } from "../utils";
import { resolveReadPath } from "./path-utils";
import { getEnv } from "./web-search/auth";

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

type ImageProvider = "gemini" | "openrouter";
interface ImageApiKey {
	provider: ImageProvider;
	apiKey: string;
}

const responseModalitySchema = Type.Union([Type.Literal("Image"), Type.Literal("Text")]);
const aspectRatioSchema = Type.Union(
	[Type.Literal("1:1"), Type.Literal("3:4"), Type.Literal("4:3"), Type.Literal("9:16"), Type.Literal("16:9")],
	{ description: "Aspect ratio (1:1, 3:4, 4:3, 9:16, 16:9)." },
);
const imageSizeSchema = Type.Union([Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")], {
	description: "Image size, mainly for gemini-3-pro-image-preview.",
});

const inputImageSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Path to an input image file." })),
		data: Type.Optional(Type.String({ description: "Base64 image data or a data: URL." })),
		mime_type: Type.Optional(Type.String({ description: "Required for raw base64 data." })),
	},
	{ additionalProperties: false },
);

export const geminiImageSchema = Type.Object(
	{
		prompt: Type.String({ description: "Text prompt for image generation or editing." }),
		model: Type.Optional(
			Type.String({
				description: `Image model. Default: ${DEFAULT_MODEL} (direct Gemini) or ${DEFAULT_OPENROUTER_MODEL} (OpenRouter).`,
			}),
		),
		response_modalities: Type.Optional(
			Type.Array(responseModalitySchema, {
				description: 'Response modalities (default: ["Image"]).',
				minItems: 1,
			}),
		),
		aspect_ratio: Type.Optional(aspectRatioSchema),
		image_size: Type.Optional(imageSizeSchema),
		input_images: Type.Optional(
			Type.Array(inputImageSchema, {
				description: "Optional input images for edits or variations.",
			}),
		),
		timeout_seconds: Type.Optional(
			Type.Number({
				description: `Request timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
				minimum: 1,
				maximum: 600,
			}),
		),
	},
	{ additionalProperties: false },
);

export type GeminiImageParams = Static<typeof geminiImageSchema>;
export type GeminiResponseModality = Static<typeof responseModalitySchema>;

interface GeminiInlineData {
	data?: string;
	mimeType?: string;
}

interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
}

interface GeminiSafetyRating {
	category?: string;
	probability?: string;
}

interface GeminiPromptFeedback {
	blockReason?: string;
	safetyRatings?: GeminiSafetyRating[];
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[];
	promptFeedback?: GeminiPromptFeedback;
	usageMetadata?: GeminiUsageMetadata;
}

interface OpenRouterImageUrl {
	url: string;
}

interface OpenRouterContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: OpenRouterImageUrl;
}

interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	images?: Array<string | { image_url?: OpenRouterImageUrl }>;
}

interface OpenRouterChoice {
	message?: OpenRouterMessage;
}

interface OpenRouterResponse {
	choices?: OpenRouterChoice[];
}

interface GeminiImageToolDetails {
	provider: ImageProvider;
	model: string;
	imageCount: number;
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	usage?: GeminiUsageMetadata;
}

interface ImageInput {
	path?: string;
	data?: string;
	mime_type?: string;
}

interface InlineImageData {
	data: string;
	mimeType: string;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

function resolveOpenRouterModel(model: string): string {
	return model.includes("/") ? model : `google/${model}`;
}

function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

async function loadImageFromUrl(imageUrl: string): Promise<InlineImageData> {
	if (imageUrl.startsWith("data:")) {
		const normalized = normalizeDataUrl(imageUrl.trim());
		if (!normalized.mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType: normalized.mimeType };
	}

	const response = await fetch(imageUrl);
	if (!response.ok) {
		const rawText = await response.text();
		throw new Error(`Image download failed (${response.status}): ${rawText}`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (!contentType || !contentType.startsWith("image/")) {
		throw new Error(`Unsupported image type from URL: ${imageUrl}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	return { data: buffer.toString("base64"), mimeType: contentType };
}

function collectOpenRouterResponseText(message: OpenRouterMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") {
		const trimmed = message.content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (Array.isArray(message.content)) {
		const texts = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.filter((text): text is string => Boolean(text));
		const combined = texts.join("\n").trim();
		return combined.length > 0 ? combined : undefined;
	}
	return undefined;
}

function extractOpenRouterImageUrls(message: OpenRouterMessage | undefined): string[] {
	const urls: string[] = [];
	if (!message) return urls;
	for (const image of message.images ?? []) {
		if (typeof image === "string") {
			urls.push(image);
			continue;
		}
		if (image.image_url?.url) {
			urls.push(image.image_url.url);
		}
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type === "image_url" && part.image_url?.url) {
				urls.push(part.image_url.url);
			}
		}
	}
	return urls;
}

async function findImageApiKey(): Promise<ImageApiKey | null> {
	const openRouterKey = await getEnv("OPENROUTER_API_KEY");
	if (openRouterKey) return { provider: "openrouter", apiKey: openRouterKey };

	const geminiKey = await getEnv("GEMINI_API_KEY");
	if (geminiKey) return { provider: "gemini", apiKey: geminiKey };

	const googleKey = await getEnv("GOOGLE_API_KEY");
	if (googleKey) return { provider: "gemini", apiKey: googleKey };

	return null;
}

async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = resolveReadPath(imagePath, cwd);
	const file = Bun.file(resolved);
	if (!(await file.exists())) {
		throw new Error(`Image file not found: ${imagePath}`);
	}
	if (file.size > MAX_IMAGE_SIZE) {
		throw new Error(`Image file too large: ${imagePath}`);
	}

	const mimeType = await detectSupportedImageMimeTypeFromFile(resolved);
	if (!mimeType) {
		throw new Error(`Unsupported image type: ${imagePath}`);
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	return { data: buffer.toString("base64"), mimeType };
}

async function resolveInputImage(input: ImageInput, cwd: string): Promise<InlineImageData> {
	if (input.path) {
		return loadImageFromPath(input.path, cwd);
	}

	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		const mimeType = normalized.mimeType ?? input.mime_type;
		if (!mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType };
	}

	throw new Error("input_images entries must include either path or data.");
}

function buildResponseSummary(model: string, imageCount: number, responseText: string | undefined): string {
	const lines = [`Model: ${model}`, `Images: ${imageCount}`];
	if (responseText) {
		lines.push("", responseText.trim());
	}
	return lines.join("\n");
}

function collectResponseText(parts: GeminiPart[]): string | undefined {
	const texts = parts.map((part) => part.text).filter((text): text is string => Boolean(text));
	const combined = texts.join("\n").trim();
	return combined.length > 0 ? combined : undefined;
}

function collectInlineImages(parts: GeminiPart[]): InlineImageData[] {
	const images: InlineImageData[] = [];
	for (const part of parts) {
		const data = part.inlineData?.data;
		const mimeType = part.inlineData?.mimeType;
		if (!data || !mimeType) continue;
		images.push({ data, mimeType });
	}
	return images;
}

function combineParts(response: GeminiGenerateContentResponse): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const candidate of response.candidates ?? []) {
		const candidateParts = candidate.content?.parts ?? [];
		parts.push(...candidateParts);
	}
	return parts;
}

function createAbortController(
	signal: AbortSignal | undefined,
	timeoutSeconds: number,
): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

	let abortListener: (() => void) | undefined;
	if (signal) {
		abortListener = () => controller.abort(signal.reason);
		signal.addEventListener("abort", abortListener, { once: true });
	}

	const cleanup = () => {
		clearTimeout(timeout);
		if (abortListener && signal) {
			signal.removeEventListener("abort", abortListener);
		}
	};

	return { controller, cleanup };
}

export const geminiImageTool: CustomTool<typeof geminiImageSchema, GeminiImageToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	description: geminiImageDescription,
	parameters: geminiImageSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const apiKey = await findImageApiKey();
			if (!apiKey) {
				throw new Error("OPENROUTER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY not found.");
			}

			const provider = apiKey.provider;
			const model = params.model ?? (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL);
			const resolvedModel = provider === "openrouter" ? resolveOpenRouterModel(model) : model;
			const responseModalities = params.response_modalities ?? ["Image"];
			const cwd = ctx.sessionManager.getCwd();

			const resolvedImages: InlineImageData[] = [];
			if (params.input_images?.length) {
				for (const input of params.input_images) {
					resolvedImages.push(await resolveInputImage(input, cwd));
				}
			}

			const timeoutSeconds = params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
			const { controller, cleanup } = createAbortController(signal, timeoutSeconds);

			try {
				if (provider === "openrouter") {
					const contentParts: OpenRouterContentPart[] = [{ type: "text", text: params.prompt }];
					for (const image of resolvedImages) {
						contentParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
					}

					const requestBody = {
						model: resolvedModel,
						messages: [{ role: "user" as const, content: contentParts }],
					};

					const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey.apiKey}`,
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal,
					});

					const rawText = await response.text();
					if (!response.ok) {
						let message = rawText;
						try {
							const parsed = JSON.parse(rawText) as { error?: { message?: string } };
							message = parsed.error?.message ?? message;
						} catch {
							// Keep raw text.
						}
						throw new Error(`OpenRouter image request failed (${response.status}): ${message}`);
					}

					const data = JSON.parse(rawText) as OpenRouterResponse;
					const message = data.choices?.[0]?.message;
					const responseText = collectOpenRouterResponseText(message);
					const imageUrls = extractOpenRouterImageUrls(message);
					const inlineImages: InlineImageData[] = [];
					for (const imageUrl of imageUrls) {
						inlineImages.push(await loadImageFromUrl(imageUrl));
					}

					const content: Array<TextContent | ImageContent> = [];
					if (inlineImages.length === 0) {
						const messageText = responseText ? `\n\n${responseText}` : "";
						content.push({ type: "text", text: `No image data returned.${messageText}` });
						return {
							content,
							details: {
								provider,
								model: resolvedModel,
								imageCount: 0,
								responseText,
							},
						};
					}

					content.push({
						type: "text",
						text: buildResponseSummary(resolvedModel, inlineImages.length, responseText),
					});
					for (const image of inlineImages) {
						content.push({ type: "image", data: image.data, mimeType: image.mimeType });
					}

					return {
						content,
						details: {
							provider,
							model: resolvedModel,
							imageCount: inlineImages.length,
							responseText,
						},
					};
				}

				const parts = [] as Array<{ text?: string; inlineData?: InlineImageData }>;
				for (const image of resolvedImages) {
					parts.push({ inlineData: image });
				}
				parts.push({ text: params.prompt });

				const generationConfig: {
					responseModalities: GeminiResponseModality[];
					imageConfig?: { aspectRatio?: string; imageSize?: string };
				} = {
					responseModalities,
				};

				if (params.aspect_ratio || params.image_size) {
					generationConfig.imageConfig = {
						aspectRatio: params.aspect_ratio,
						imageSize: params.image_size,
					};
				}

				const requestBody = {
					contents: [{ role: "user" as const, parts }],
					generationConfig,
				};

				const response = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-goog-api-key": apiKey.apiKey,
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal,
					},
				);

				const rawText = await response.text();
				if (!response.ok) {
					let message = rawText;
					try {
						const parsed = JSON.parse(rawText) as { error?: { message?: string } };
						message = parsed.error?.message ?? message;
					} catch {
						// Keep raw text.
					}
					throw new Error(`Gemini image request failed (${response.status}): ${message}`);
				}

				const data = JSON.parse(rawText) as GeminiGenerateContentResponse;
				const responseParts = combineParts(data);
				const responseText = collectResponseText(responseParts);
				const inlineImages = collectInlineImages(responseParts);
				const content: Array<TextContent | ImageContent> = [];

				if (inlineImages.length === 0) {
					const blocked = data.promptFeedback?.blockReason
						? `Blocked: ${data.promptFeedback.blockReason}`
						: "No image data returned.";
					content.push({ type: "text", text: `${blocked}${responseText ? `\n\n${responseText}` : ""}` });
					return {
						content,
						details: {
							provider,
							model,
							imageCount: 0,
							responseText,
							promptFeedback: data.promptFeedback,
							usage: data.usageMetadata,
						},
					};
				}

				content.push({
					type: "text",
					text: buildResponseSummary(model, inlineImages.length, responseText),
				});
				for (const image of inlineImages) {
					content.push({ type: "image", data: image.data, mimeType: image.mimeType });
				}

				return {
					content,
					details: {
						provider,
						model,
						imageCount: inlineImages.length,
						responseText,
						promptFeedback: data.promptFeedback,
						usage: data.usageMetadata,
					},
				};
			} finally {
				cleanup();
			}
		});
	},
};

export async function getGeminiImageTools(): Promise<
	Array<CustomTool<typeof geminiImageSchema, GeminiImageToolDetails>>
> {
	const apiKey = await findImageApiKey();
	if (!apiKey) return [];
	return [geminiImageTool];
}
