import type { ImageContent } from "@oh-my-pi/pi-ai";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/** Pixel dimensions read from ordinary image headers. */
export interface ImageSize {
	width: number;
	height: number;
}
export type ImageDetail = ImageContent["detail"];

/** Conservative request budget without guessing a model vendor's billing rules. */
export function estimateImageTokens(_size: ImageSize | null | undefined, detail?: ImageDetail): number {
	return detail === "low" ? 1024 : 5024;
}

// Enough decoded bytes to reach a JPEG SOF marker behind typical EXIF/ICC
// segments; PNG/GIF/WebP need only the first 30 bytes. Multiple of 4 so the
// base64 slice decodes cleanly.
const HEADER_BASE64_CHARS = 4 * Math.ceil((64 * 1024) / 3);

/** Pixel size read from the header of base64-encoded image data, or null. */
export function base64ImageSize(base64: string): ImageSize | null {
	if (base64.length === 0) return null;
	const header = Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), "base64");
	const metadata = parseImageMetadata(header);
	if (!metadata?.width || !metadata.height) return null;
	return { width: metadata.width, height: metadata.height };
}

/** Pixel size of a `data:<mime>;base64,` URL, or null for any other URL. */
export function dataUrlImageSize(url: string): ImageSize | null {
	if (!url.startsWith("data:")) return null;
	const comma = url.indexOf(",");
	if (comma < 0 || !url.slice(0, comma).endsWith(";base64")) return null;
	return base64ImageSize(url.slice(comma + 1));
}
