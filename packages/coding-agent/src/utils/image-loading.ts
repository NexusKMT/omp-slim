import * as fs from "node:fs/promises";
import type { ImageContent, Message, Model } from "@oh-my-pi/pi-ai";
import { formatBytes, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;
const MODEL_BOUNDARY_IMAGE_CACHE_LIMIT = 128;
type NormalizedImagePayload = Pick<ImageContent, "data" | "mimeType">;
const modelBoundaryImageCache = new LRUCache<string, Promise<NormalizedImagePayload>>({
	max: MODEL_BOUNDARY_IMAGE_CACHE_LIMIT,
});

function hasWebPMagic(data: string): boolean {
	const header = Buffer.from(data.slice(0, 16), "base64");
	return (
		header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
	);
}

function isWebPImage(image: ImageContent): boolean {
	return image.mimeType.toLowerCase() === "image/webp" || hasWebPMagic(image.data);
}

function modelBoundaryImageCacheKey(image: ImageContent): string {
	return `${image.data.length}:${image.data.slice(0, 32)}:${image.data.slice(-32)}:${String(Bun.hash(image.data))}`;
}

async function memoizedStbImageNormalization(image: ImageContent): Promise<ImageContent> {
	const key = modelBoundaryImageCacheKey(image);
	let pending = modelBoundaryImageCache.get(key);
	if (!pending) {
		pending = resizeImage(image, { excludeWebP: true }).then(resized => {
			if (resized.mimeType === "image/webp" || hasWebPMagic(resized.data)) {
				throw new Error("Image normalization retained WebP for an STB-backed model");
			}
			return { data: resized.data, mimeType: resized.mimeType };
		});
		modelBoundaryImageCache.set(key, pending);
		void pending.catch(() => {
			if (modelBoundaryImageCache.peek(key) === pending) modelBoundaryImageCache.delete(key);
		});
	}
	return { ...image, ...(await pending) };
}

/**
 * Ollama and its local-backend family decode image input through llama.cpp /
 * `stb_image`, which is compiled without WebP support, so a WebP upload fails
 * with an opaque HTTP 400. Detect those models so the resize pipeline encodes
 * to PNG/JPEG instead — the automatic equivalent of `OMP_NO_WEBP=1`.
 */
export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

/**
 * `true` when `model` cannot decode WebP, otherwise `undefined` so the
 * `OMP_NO_WEBP` env fallback in {@link resizeImage} still applies. Feed straight
 * into {@link ImageResizeOptions.excludeWebP}.
 */
export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

/** Options for loading an in-memory chat image attachment as a vision-model input. */
export interface LoadImageAttachmentInputOptions {
	image: ImageContent;
	label: string;
	uri: string;
	autoResize: boolean;
	maxBytes?: number;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch {
		return null;
	}
}

export interface NormalizeModelContextImagesOptions {
	/** Model the images are bound for; used to derive encoder constraints (WebP exclusion for Ollama). */
	model?: Model;
	resize?: ImageResizeOptions;
}

/**
 * Normalize image blocks before they enter agent/model context. This keeps
 * provider request construction from having to resize an unbounded batch of
 * large images on the streaming hot path. Images are processed sequentially on
 * purpose: `resizeImage` may fan out multiple encoders for one image, so the
 * outer image batch must stay bounded.
 */
export async function normalizeModelContextImages(
	images: ImageContent[] | undefined,
	options?: NormalizeModelContextImagesOptions,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const excludesWebP = modelLacksWebpSupport(options?.model);
	const resize: ImageResizeOptions | undefined = excludesWebP
		? { ...options?.resize, excludeWebP: true }
		: options?.resize;
	const normalized: ImageContent[] = [];
	for (const image of images) {
		try {
			if (excludesWebP && isWebPImage(image)) {
				normalized.push(await memoizedStbImageNormalization(image));
				continue;
			}
			const resized = await resizeImage(image, resize);
			normalized.push({ ...image, data: resized.data, mimeType: resized.mimeType });
		} catch (error) {
			if (excludesWebP && isWebPImage(image)) {
				throw new Error("Failed to convert WebP image for an STB-backed model", { cause: error });
			}
			// Preserve existing caller behavior for decode/resize failures: keep the
			// user's image block rather than dropping it from the turn.
			normalized.push(image);
		}
	}
	return normalized;
}

/**
 * Rewrites historical/resumed WebP blocks in the ephemeral provider request.
 * Persisted session messages remain untouched, while STB-backed local servers
 * never receive a format they cannot decode.
 */
export async function normalizeModelContextMessages(messages: Message[], model: Model | undefined): Promise<Message[]> {
	if (!modelLacksWebpSupport(model)) return messages;
	let output: Message[] | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		if (typeof message.content === "string") continue;
		const webpImages: ImageContent[] = [];
		for (const part of message.content) {
			if (part.type === "image" && isWebPImage(part)) webpImages.push(part);
		}
		if (webpImages.length === 0) continue;
		const normalized = await normalizeModelContextImages(webpImages, { model });
		if (!normalized) continue;
		let imageIndex = 0;
		const content = message.content.map(part =>
			part.type === "image" && isWebPImage(part) ? normalized[imageIndex++]! : part,
		);
		output ??= messages.slice();
		output[messageIndex] = { ...message, content } as Message;
	}
	return output ?? messages;
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	let outputData = Buffer.from(inputBuffer).toBase64();
	let outputMimeType = mimeType;
	let outputBytes = inputBuffer.byteLength;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = options.excludeWebP === true && mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(
				{ type: "image", data: outputData, mimeType },
				{ excludeWebP: options.excludeWebP },
			);
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// keep original image when resize fails
		}
	}

	let textNote = `Read image file [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

/** Loads a chat attachment image through the same size and encoder policy as file-backed image inputs. */
export async function loadImageAttachmentInput(
	options: LoadImageAttachmentInputOptions,
): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(options.image.mimeType)) {
		return null;
	}

	const inputBytes = Buffer.byteLength(options.image.data, "base64");
	if (inputBytes > maxBytes) {
		throw new ImageInputTooLargeError(inputBytes, maxBytes);
	}

	let outputData = options.image.data;
	let outputMimeType = options.image.mimeType;
	let outputBytes = inputBytes;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = options.excludeWebP === true && options.image.mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(options.image, { excludeWebP: options.excludeWebP });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// keep original image when resize fails
		}
	}

	let textNote = `Read image attachment ${options.label} [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: options.uri,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}
