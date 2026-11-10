import * as fs from "node:fs/promises";
import {
	MAX_IMAGE_INPUT_BYTES,
	SUPPORTED_INPUT_IMAGE_MIME_TYPES,
	ImageInputTooLargeError,
	InvalidImageDataError,
	imageDecodeFailureReason,
} from "@oh-my-pi/pi-tui/chat/image-loading";
import * as path from "node:path";
import type { Context, ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { $which, logger, readImageMetadata } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, type ImageResizeOptions, isWebPExcluded, resizeImage } from "./image-resize";
import { decodeStillImageJpeg, VideoError } from "./video";

/** Largest edge rasterized from SVG before it enters the image pipeline. */
const SVG_IMAGE_MAX_EDGE_PX = 2048;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE = 64 * 1024 * 1024;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES = 128;
type NormalizedImagePayload = Pick<ImageContent, "data" | "mimeType">;
const modelBoundaryImageCache = new LRUCache<string, NormalizedImagePayload | null>({
	max: MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES,
	maxSize: MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE,
	sizeCalculation: payload => Math.max(1, payload?.data.length ?? 1),
});
const modelBoundaryImageNormalizations = new Map<string, Promise<NormalizedImagePayload | null>>();
const UNDECODABLE_STB_IMAGE_OMISSION_TEXT = "[image omitted: WebP could not be decoded for this model]";

function createUndecodableStbImageOmission(): TextContent {
	return { type: "text", text: UNDECODABLE_STB_IMAGE_OMISSION_TEXT };
}

function hasWebPMagic(data: string): boolean {
	const header = Buffer.from(data.slice(0, 16), "base64");
	return (
		header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
	);
}

function isWebPImage(image: ImageContent): boolean {
	if (typeof image.data !== "string") return false;
	const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : undefined;
	return mimeType === "image/webp" || hasWebPMagic(image.data);
}

function modelBoundaryImageCacheKey(image: ImageContent, resize: ImageResizeOptions | undefined): string {
	const resizeKey = JSON.stringify([
		resize?.maxWidth,
		resize?.maxHeight,
		resize?.minDimension,
		resize?.maxBytes,
		resize?.jpegQuality,
	]);
	return `${resizeKey}:${image.mimeType}:${image.data.length}:${image.data.slice(0, 32)}:${image.data.slice(-32)}:${String(Bun.hash(image.data))}`;
}

async function memoizedStbImageNormalization(
	image: ImageContent,
	resize: ImageResizeOptions | undefined,
): Promise<ImageContent | null> {
	const key = modelBoundaryImageCacheKey(image, resize);
	const cached = modelBoundaryImageCache.get(key);
	if (cached !== undefined) return cached ? { ...image, ...cached } : null;

	let pending = modelBoundaryImageNormalizations.get(key);
	if (!pending) {
		pending = resizeImage(image, { ...resize, excludeWebP: true })
			.then(resized => {
				if (resized.mimeType === "image/webp" || hasWebPMagic(resized.data)) {
					throw new Error("Image normalization retained WebP for the configured image format restriction");
				}
				return { data: resized.data, mimeType: resized.mimeType };
			})
			.catch(error => {
				logger.warn("Dropping undecodable WebP for the configured image format restriction", {
					error: String(error),
				});
				return null;
			})
			.then(payload => {
				modelBoundaryImageCache.set(key, payload);
				return payload;
			})
			.finally(() => modelBoundaryImageNormalizations.delete(key));
		modelBoundaryImageNormalizations.set(key, pending);
	}
	const normalized = await pending;
	return normalized ? { ...image, ...normalized } : null;
}

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	/** Force non-WebP output. Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

/** Options for loading an in-memory chat image attachment as a vision-model input. */
export interface LoadImageAttachmentInputOptions {
	image: ImageContent;
	label: string;
	uri: string;
	autoResize: boolean;
	maxBytes?: number;
	/** Force non-WebP output. Leave unset to honor `OMP_NO_WEBP`. */
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

interface LoadInMemoryImageInputOptions {
	image: ImageContent;
	/** Raw bytes of `image.data` when the caller already holds them; skips a base64 decode in resize. */
	bytes?: Uint8Array;
	resolvedPath: string;
	textNotePrefix: string;
	/** Original file type when the display image was rasterized before loading. */
	sourceMimeType?: string;
	autoResize: boolean;
	maxBytes: number;
	excludeWebP: boolean | undefined;
}

async function loadInMemoryImageInput(options: LoadInMemoryImageInputOptions): Promise<LoadedImageInput> {
	const inputBytes = Buffer.byteLength(options.image.data, "base64");
	if (inputBytes > options.maxBytes) {
		throw new ImageInputTooLargeError(inputBytes, options.maxBytes);
	}

	// Decode before anything else: a payload that cannot be decoded is rejected
	// by the provider for the whole request, so it must fail here — where the
	// caller still has a path to act on — instead of entering the transcript.
	const decodeFailure = await imageDecodeFailureReason(options.image);
	if (decodeFailure !== null) {
		throw new InvalidImageDataError(options.resolvedPath, options.image.mimeType, decodeFailure);
	}

	let outputData = options.image.data;
	let outputMimeType = options.image.mimeType;
	let outputBytes = inputBytes;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = options.excludeWebP === true && options.image.mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(
				options.bytes
					? { bytes: options.bytes, mimeType: options.image.mimeType, data: options.image.data }
					: options.image,
				{ excludeWebP: options.excludeWebP },
			);
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// Keep the original image when resize fails.
		}
	}

	const sourceMimeType = options.sourceMimeType ?? options.image.mimeType;
	let textNote = `${options.textNotePrefix} [${sourceMimeType}]`;
	if (outputMimeType !== sourceMimeType) {
		textNote += ` (displayed as ${outputMimeType})`;
	}
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: options.resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

export interface NormalizeModelContextImagesOptions {
	/** Explicitly force WebP conversion; otherwise honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
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
	const excludesWebP = options?.excludeWebP ?? isWebPExcluded();
	const resize: ImageResizeOptions | undefined = excludesWebP
		? { ...options?.resize, excludeWebP: true }
		: options?.resize;
	const normalized: ImageContent[] = [];
	for (const image of images) {
		try {
			if (excludesWebP && isWebPImage(image)) {
				const converted = await memoizedStbImageNormalization(image, options?.resize);
				// Mixed-content callers reassemble normalized images positionally, so
				// preserve one output slot per input. The provider-boundary pass replaces
				// an undecodable WebP with an omission note before dispatch.
				normalized.push(converted ?? image);
				continue;
			}
			const resized = await resizeImage(image, resize);
			normalized.push({ ...image, data: resized.data, mimeType: resized.mimeType });
		} catch {
			// Preserve existing caller behavior for decode/resize failures: keep the
			// user's image block rather than dropping it from the turn.
			normalized.push(image);
		}
	}
	return normalized;
}

/**
 * Rewrites historical/resumed WebP blocks in the ephemeral provider request.
 * Persisted session messages remain untouched, while explicitly configured format restrictions apply to resumed images too.
 */
export async function normalizeModelContextMessages(
	messages: Message[],
	options?: Pick<NormalizeModelContextImagesOptions, "excludeWebP">,
): Promise<Message[]> {
	if (!(options?.excludeWebP ?? isWebPExcluded())) return messages;
	let output: Message[] | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		let content: Array<(typeof message.content)[number]> | undefined;
		if (typeof message.content !== "string") {
			for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
				const part = message.content[partIndex]!;
				if (part.type !== "image" || !isWebPImage(part)) {
					content?.push(part);
					continue;
				}
				content ??= message.content.slice(0, partIndex);
				const normalized = await memoizedStbImageNormalization(part, undefined);
				content.push(normalized ?? createUndecodableStbImageOmission());
			}
		}
		if (!content) continue;
		output ??= messages.slice();
		const normalizedMessage = { ...message, ...(content ? { content } : {}) } as Message;
		if (normalizedMessage.role === "user" || normalizedMessage.role === "developer") {
			// A converted block supersedes opaque history bytes on this ephemeral request.
			delete normalizedMessage.providerPayload;
		}
		output[messageIndex] = normalizedMessage;
	}
	return output ?? messages;
}

/** Normalizes historical image blocks in an ephemeral provider request. */
export async function normalizeProviderContextImages(
	context: Context,
	options?: Pick<NormalizeModelContextImagesOptions, "excludeWebP">,
): Promise<Context> {
	const messages = await normalizeModelContextMessages(context.messages, options);
	return messages === context.messages ? context : { ...context, messages };
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
	return loadInMemoryImageInput({
		image: { type: "image", data: inputBuffer.toBase64(), mimeType },
		bytes: inputBuffer,
		resolvedPath,
		textNotePrefix: "Read image file",
		autoResize: options.autoResize,
		maxBytes,
		excludeWebP: options.excludeWebP,
	});
}

/** Rasterizes an explicitly selected local SVG/SVGZ into a vision-model image input. */
export async function loadSvgImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const extension = path.extname(resolvedPath).toLowerCase();
	if (extension !== ".svg" && extension !== ".svgz") return null;

	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const source = await fs.readFile(resolvedPath);
	if (source.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(source.byteLength, maxBytes);
	}

	let png: Uint8Array;
	try {
		png = await rasterizeSvg(source, SVG_IMAGE_MAX_EDGE_PX, SVG_IMAGE_MAX_EDGE_PX);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not rasterize SVG: ${message}`);
	}

	return loadInMemoryImageInput({
		image: { type: "image", data: png.toBase64(), mimeType: "image/png" },
		bytes: png,
		resolvedPath,
		textNotePrefix: "Read SVG file",
		sourceMimeType: "image/svg+xml",
		autoResize: options.autoResize,
		maxBytes,
		excludeWebP: options.excludeWebP,
	});
}

/** Decodes a local HEIC, HEIF or AVIF still image with ffmpeg into a vision-model image input. */
export async function loadHeifImageInput(
	options: LoadImageInputOptions,
	signal?: AbortSignal,
): Promise<LoadedImageInput> {
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const sourceMimeType = options.detectedMimeType ?? "image/heif";
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	let jpeg: Uint8Array;
	try {
		jpeg = await decodeStillImageJpeg(resolvedPath, maxBytes, signal);
	} catch (error) {
		if (!(error instanceof VideoError) || signal?.aborted) throw error;
		const format = sourceMimeType.slice("image/".length).toUpperCase();
		const cause = $which("ffmpeg") ? error.message : "Decoding it needs ffmpeg 8.1 or newer, which is not on PATH.";
		throw new Error(
			`Could not decode ${format} image. Convert it to PNG or JPEG (e.g. \`sips -s format jpeg -Z 4096\` on macOS) and read that file.\n${cause}`,
		);
	}

	return loadInMemoryImageInput({
		image: { type: "image", data: jpeg.toBase64(), mimeType: "image/jpeg" },
		bytes: jpeg,
		resolvedPath,
		textNotePrefix: "Read image file",
		sourceMimeType,
		autoResize: options.autoResize,
		maxBytes,
		excludeWebP: options.excludeWebP,
	});
}

/** Loads a chat attachment image through the same size and encoder policy as file-backed image inputs. */
export async function loadImageAttachmentInput(
	options: LoadImageAttachmentInputOptions,
): Promise<LoadedImageInput | null> {
	const image = { ...options.image, mimeType: options.image.mimeType.toLowerCase() };
	if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return null;
	}

	return loadInMemoryImageInput({
		image,
		resolvedPath: options.uri,
		textNotePrefix: `Read image attachment ${options.label}`,
		autoResize: options.autoResize,
		maxBytes: options.maxBytes ?? MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}
