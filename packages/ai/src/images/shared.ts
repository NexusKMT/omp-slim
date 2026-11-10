import { base64ImageDataFailureReason, isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { ImageContent } from "../types";
type ImageInput = Pick<ImageContent, "data" | "mimeType">;
/**
 * Mime type of a base64 image, read from its header only. 64 base64 chars
 * decode to 48 bytes, past every magic number `parseImageMetadata` checks, so
 * multi-MB payloads are never fully decoded just to be labelled.
 */
export function sniffBase64ImageMimeType(base64: string): string | undefined {
	return parseImageMetadata(Buffer.from(base64.slice(0, 64), "base64"))?.mimeType;
}

/**
 * Validate provider-bound image input without changing it. Accepts non-empty standard base64
 * with canonical trailing bits and optional padding, and case-insensitive image MIME syntax
 * (RFC 6838 restricted names). Does not sniff the MIME type, decode image pixels, or enforce
 * provider-specific format support; data-URL transports additionally go through `toDataUrl`.
 *
 * @throws {AIError.ValidationError} If the base64 data or image MIME type is invalid.
 */
export function validateImageInput(image: ImageInput): void {
	if (!isRecord(image) || typeof image.data !== "string") {
		throw new AIError.ValidationError("invalid base64 image data");
	}
	const reason = base64ImageDataFailureReason(image.data);
	if (reason) throw new AIError.ValidationError(reason);
	if (!isImageMimeType(image.mimeType)) throw new AIError.ValidationError("invalid image MIME type");
}

/**
 * Encode validated image input as a base64 data URL.
 *
 * @throws {AIError.ValidationError} If the input is invalid or its MIME type cannot survive a data URL.
 */
export function toDataUrl(image: ImageInput): string {
	validateImageInput(image);
	if (!isDataUrlMimeType(image.mimeType)) {
		throw new AIError.ValidationError("image MIME type containing '#' cannot be sent as a data URL");
	}
	return `data:${image.mimeType};base64,${image.data}`;
}

// RFC 6838 restricted-name.
const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/i;
const IMAGE_DETAILS: Record<string, true> = {
	auto: true,
	low: true,
	high: true,
	original: true,
};

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && IMAGE_MIME_TYPE.test(value);
}

/**
 * Whether a MIME type survives a data URL intact: a raw `#` starts a URL fragment and
 * data-URL consumers leave a `%23` escape undecoded, so no data-URL transport preserves it.
 */
export function isDataUrlMimeType(mimeType: string): boolean {
	return !mimeType.includes("#");
}

function isEmbeddedImageShape(image: unknown): image is ImageContent {
	return (
		isRecord(image) &&
		image.type === "image" &&
		typeof image.data === "string" &&
		isImageMimeType(image.mimeType) &&
		isDataUrlMimeType(image.mimeType) &&
		(image.detail === undefined || (typeof image.detail === "string" && Object.hasOwn(IMAGE_DETAILS, image.detail)))
	);
}

/** Whether a value is an embedded image with valid base64 data, MIME type, and detail. */
export function isEmbeddedImageContent(image: unknown): image is ImageContent {
	return isEmbeddedImageShape(image) && base64ImageDataFailureReason(image.data) === undefined;
}

/** Convert one validated embedded image to a lowercase-MIME inline data URL. */
export function embeddedImageDataUrl(image: unknown): string {
	if (!isEmbeddedImageShape(image)) {
		throw new AIError.ValidationError("Judgment images must contain non-empty base64 data and an image MIME type");
	}
	return toDataUrl({ data: image.data, mimeType: image.mimeType.toLowerCase() });
}
