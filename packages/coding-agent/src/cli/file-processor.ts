/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import chalk from "chalk";
import sharp from "sharp";
import { resolveReadPath } from "../core/tools/path-utils";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

const RESIZE_TRIGGER_MAX_DIMENSION = 2048;
const MAX_RESIZE_WIDTH = 1920;
const MAX_RESIZE_HEIGHT = 1080;
const JPEG_CONVERT_THRESHOLD_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 85;

async function processImageAttachment(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
	const metadata = await sharp(buffer, { failOnError: false }).metadata();
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	const maxDim = Math.max(width, height);
	const shouldResize = width > 0 && height > 0 && maxDim > RESIZE_TRIGGER_MAX_DIMENSION;
	const shouldConvertToJpeg = buffer.length > JPEG_CONVERT_THRESHOLD_BYTES;

	if (!shouldResize && !shouldConvertToJpeg) {
		return { buffer, mimeType };
	}

	let pipeline = sharp(buffer, { failOnError: false });
	if (shouldResize) {
		pipeline = pipeline.resize({
			width: MAX_RESIZE_WIDTH,
			height: MAX_RESIZE_HEIGHT,
			fit: "inside",
			withoutEnlargement: true,
		});
	}

	if (shouldConvertToJpeg) {
		pipeline = pipeline.jpeg({ quality: JPEG_QUALITY });
		return { buffer: await pipeline.toBuffer(), mimeType: "image/jpeg" };
	}

	if (mimeType === "image/png") {
		pipeline = pipeline.png();
	} else if (mimeType === "image/webp") {
		pipeline = pipeline.webp();
	} else if (mimeType === "image/gif") {
		pipeline = pipeline.gif();
	} else {
		pipeline = pipeline.jpeg({ quality: JPEG_QUALITY });
		return { buffer: await pipeline.toBuffer(), mimeType: "image/jpeg" };
	}

	return { buffer: await pipeline.toBuffer(), mimeType };
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[]): Promise<ProcessedFiles> {
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);
			const processed = await processImageAttachment(content, mimeType);
			const base64Content = processed.buffer.toString("base64");

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: base64Content,
			};

			images.push(attachment);

			// Add text reference to image
			text += `<file name="${absolutePath}"></file>\n`;
		} else {
			// Handle text file
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
