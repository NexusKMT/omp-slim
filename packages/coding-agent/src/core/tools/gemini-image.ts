import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import geminiImageDescription from "../../prompts/tools/gemini-image.md" with { type: "text" };
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime";
import type { CustomTool } from "../custom-tools/types";
import { untilAborted } from "../utils";
import { resolveReadPath } from "./path-utils";
import { getEnv } from "./web-search/auth";

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

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
				description: `Gemini image model. Default: ${DEFAULT_MODEL} (Nano Banana).`,
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

interface GeminiImageToolDetails {
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

async function findGeminiApiKey(): Promise<string | null> {
	const geminiKey = await getEnv("GEMINI_API_KEY");
	if (geminiKey) return geminiKey;

	const googleKey = await getEnv("GOOGLE_API_KEY");
	if (googleKey) return googleKey;

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
	name: "gemini_image",
	label: "Gemini Image",
	description: geminiImageDescription,
	parameters: geminiImageSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const apiKey = await findGeminiApiKey();
			if (!apiKey) {
				throw new Error("GEMINI_API_KEY not found.");
			}

			const model = params.model ?? DEFAULT_MODEL;
			const responseModalities = params.response_modalities ?? ["Image"];
			const cwd = ctx.sessionManager.getCwd();

			const parts = [] as Array<{ text?: string; inlineData?: InlineImageData }>;
			if (params.input_images?.length) {
				for (const input of params.input_images) {
					const image = await resolveInputImage(input, cwd);
					parts.push({ inlineData: image });
				}
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

			const timeoutSeconds = params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
			const { controller, cleanup } = createAbortController(signal, timeoutSeconds);

			try {
				const response = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-goog-api-key": apiKey,
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
	const apiKey = await findGeminiApiKey();
	if (!apiKey) return [];
	return [geminiImageTool];
}
