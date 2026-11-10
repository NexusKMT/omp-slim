/** Preserve images for text-only sessions without invoking another model. */
import * as path from "node:path";
import type { Api, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Settings } from "../config/settings";
import { type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls";
import { cfgImagesBlockImages } from "../modes/settings";

const IMAGE_SAVED_NOTE =
	"[The current model does not support image input. The image was saved. " +
	"Select a primary model that supports images, then read the saved image to analyze it.]";

/** Whether a text-only session needs a saved-image notice. */
export function shouldDescribeImagesForTextModel(
	model: Model<Api> | undefined,
	settings: Settings,
): model is Model<Api> {
	return !!model && !sendsImageInputOnWire(model) && !cfgImagesBlockImages.get(settings);
}

export interface DescribeAttachedImagesDeps {
	localProtocolOptions: LocalProtocolOptions;
}

/** Map an image MIME type to a file extension for the saved artifact. */
function extensionForMime(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
	switch (subtype) {
		case "jpeg":
		case "jpg":
			return "jpg";
		case "png":
			return "png";
		case "gif":
			return "gif";
		case "webp":
			return "webp";
		default: {
			const sanitized = subtype.replace(/[^a-z0-9]/g, "");
			return sanitized || "png";
		}
	}
}

/** Content-addressed file name so re-pasting the same image reuses one artifact. */
function imageFileName(image: ImageContent): string {
	const hash = Bun.hash(image.data).toString(16);
	return `image-${hash}.${extensionForMime(image.mimeType)}`;
}

/** Persist an image under the local root; returns its `local://` URL. */
async function saveImage(image: ImageContent, localRoot: string): Promise<string> {
	const fileName = imageFileName(image);
	const filePath = path.join(localRoot, fileName);
	// Content-addressed: identical bytes overwrite themselves harmlessly. Bun.write creates parent dirs.
	await Bun.write(filePath, Buffer.from(image.data, "base64"));
	return `local://${fileName}`;
}

function formatImageBlock(localUrl: string, description: string): string {
	return `<image path="${localUrl}">\n${description}\n</image>`;
}

/** Save each attachment and emit its path and the current model's image limitation. */
export async function describeAttachedImagesForTextModel(
	images: readonly ImageContent[],
	deps: DescribeAttachedImagesDeps,
	signal?: AbortSignal,
): Promise<TextContent[]> {
	signal?.throwIfAborted();
	const localRoot = resolveLocalRoot(deps.localProtocolOptions);
	return Promise.all(
		images.map(async (image): Promise<TextContent> => {
			signal?.throwIfAborted();
			const localUrl = await saveImage(image, localRoot);
			return { type: "text", text: formatImageBlock(localUrl, IMAGE_SAVED_NOTE) };
		}),
	);
}
