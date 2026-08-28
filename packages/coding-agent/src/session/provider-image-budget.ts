import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { providerImageBudget } from "@oh-my-pi/snapcompact";
import { imageDecodeFailureReason } from "../utils/image-loading";

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: content.length > 0 ? content : [TOOL_RESULT_IMAGE_OMISSION] };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the active provider's image cap. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const totalImages = countImages(context);
	if (totalImages <= limit) return context;

	const state = { remainingDrops: totalImages - limit };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}

/**
 * Decode verdicts keyed by payload hash: the same historical images ride along
 * on every turn of a session, and decoding all of them per request would be a
 * real cost. `null` means the image decodes.
 */
const IMAGE_DECODE_CACHE_MAX_ENTRIES = 512;
const imageDecodeFailures = new LRUCache<string, string | null>({ max: IMAGE_DECODE_CACHE_MAX_ENTRIES });

async function unreadableImageReason(image: ImageContent): Promise<string | null> {
	const key = `${image.mimeType}:${image.data.length}:${String(Bun.hash(image.data))}`;
	const cached = imageDecodeFailures.get(key);
	if (cached !== undefined) return cached;
	const reason = await imageDecodeFailureReason(image);
	imageDecodeFailures.set(key, reason);
	return reason;
}

/** `undefined` when every image decodes, so callers can keep the original array. */
async function replaceUnreadableContent(
	content: readonly (TextContent | ImageContent)[],
): Promise<(TextContent | ImageContent)[] | undefined> {
	let replaced: (TextContent | ImageContent)[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part.type !== "image") continue;
		const reason = await unreadableImageReason(part);
		if (reason === null) continue;
		replaced ??= [...content];
		replaced[index] = {
			type: "text",
			text: `[image omitted: undecodable ${part.mimeType ?? "image"} data (${reason})]`,
		};
	}
	return replaced;
}

/** `undefined` when the message needs no rewrite. */
async function dropUnreadableFromMessage(message: Message): Promise<Message | undefined> {
	switch (message.role) {
		case "user":
		case "developer": {
			if (!Array.isArray(message.content)) return undefined;
			const content = await replaceUnreadableContent(message.content);
			// The provider payload embeds the same bytes, so it has to be rebuilt
			// from the rewritten content rather than replayed verbatim.
			return content ? { ...message, content, providerPayload: undefined } : undefined;
		}
		case "toolResult": {
			const content = await replaceUnreadableContent(message.content);
			return content ? { ...message, content } : undefined;
		}
		case "assistant":
			return undefined;
	}
}

/**
 * Last line of defence before the wire: an undecodable image makes the provider
 * reject the entire request rather than the offending block, so one bad payload
 * anywhere in history leaves the session permanently unable to send. Degrades
 * those blocks to text and leaves everything else — including the `context`
 * object itself — untouched.
 */
export async function dropUnreadableContextImages(context: Context): Promise<Context> {
	let messages: Message[] | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const rewritten = await dropUnreadableFromMessage(context.messages[index]);
		if (!rewritten) continue;
		messages ??= [...context.messages];
		messages[index] = rewritten;
	}
	return messages ? { ...context, messages } : context;
}
