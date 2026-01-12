import { convertToPngWithImageMagick } from "./image-magick";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 * Uses sharp if available, falls back to ImageMagick (magick/convert).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	// Try sharp first
	try {
		// Use variable to prevent bun from statically analyzing the import
		const sharpModule = "sharp";
		const sharp = (await import(/* @vite-ignore */ sharpModule)).default;
		const buffer = Buffer.from(base64Data, "base64");
		const pngBuffer = await sharp(buffer).png().toBuffer();
		return {
			data: pngBuffer.toString("base64"),
			mimeType: "image/png",
		};
	} catch {
		// Sharp not available, try ImageMagick fallback
	}

	// Fall back to ImageMagick
	return convertToPngWithImageMagick(base64Data, mimeType);
}
