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
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { capFrameDataBytes, DEFAULT_FRAME_DATA_BYTES_BUDGET, DEFAULT_IMAGE_BUDGET } from "@oh-my-pi/snapcompact";
import { imageDecodeFailureReason } from "@oh-my-pi/pi-tui/chat/image-loading";

const IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * Body bytes added after the clamp sees the context: injected reminders, the provider's own system prompt, and
 * request fields (model, limits, thinking, stream). Reserved before protecting images against a body limit.
 */
const REQUEST_ENVELOPE_BYTES = 64_000;

/** Count input images; assistant output images are never replayed as input. */
function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (message.role === "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function inlineImageBytes(image: ImageContent): number {
	if (image.url)
		return image.url.slice(0, 5).toLowerCase() === "data:" ? Buffer.byteLength(JSON.stringify(image.url)) - 2 : 0;
	return image.data.length; // Base64 is ASCII, so character count equals JSON byte count.
}

/** Inline image bytes a user, developer or tool-result message puts on the wire. */
function sentImageBytes(message: Message): number {
	if (!Array.isArray(message.content)) return 0;
	let bytes = 0;
	for (const part of message.content) {
		if (part.type === "image") bytes += inlineImageBytes(part);
	}
	return bytes;
}

interface ImageBudgetState {
	remainingDrops: number;
	inlineBytes: number;
	byteBudget: number;
	/** Messages whose images the byte clamp must not evict. */
	kept?: ReadonlySet<Message>;
}

function needsImageDrop(state: ImageBudgetState): boolean {
	return state.remainingDrops > 0 || state.inlineBytes > state.byteBudget;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: ImageBudgetState,
): (TextContent | ImageContent)[] | undefined {
	let clamped: (TextContent | ImageContent)[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part.type === "image" && needsImageDrop(state)) {
			const bytes = state.byteBudget === Number.POSITIVE_INFINITY ? 0 : inlineImageBytes(part);
			if (state.remainingDrops > 0 || (state.inlineBytes > state.byteBudget && bytes > 0)) {
				clamped ??= content.slice(0, index);
				if (state.remainingDrops > 0) state.remainingDrops--;
				state.inlineBytes -= bytes;
				continue;
			}
		}
		clamped?.push(part);
	}
	// An image-only message would otherwise go out empty; converters skip
	// zero-block messages, silently losing the turn (e.g. an oversized pasted image).
	return clamped && clamped.length === 0 ? [IMAGE_OMISSION] : clamped;
}

function clampUserMessage(message: UserMessage, state: ImageBudgetState): UserMessage {
	if (!Array.isArray(message.content) || !needsImageDrop(state)) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: ImageBudgetState): DeveloperMessage {
	if (!Array.isArray(message.content) || !needsImageDrop(state)) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: ImageBudgetState): ToolResultMessage {
	if (!needsImageDrop(state)) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content } : message;
}

function clampImages(context: Context, state: ImageBudgetState): Context {
	const messages = context.messages.map(message => {
		if (state.kept?.has(message)) return message;
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
 * Drops oldest transient image blocks so outgoing vision requests fit the active provider's image cap.
 *
 * {@link countImages} counts exactly the roles {@link clampImages} can drop, so the
 * budget is always fully spendable and the clamp never evicts an input image
 * on behalf of a model output.
 */
export function clampProviderContextImages(context: Context, model: Model, maxImages = DEFAULT_IMAGE_BUDGET): Context {
	if (!model.input.includes("image")) return context;
	const totalImages = countImages(context);
	const remainingDrops = totalImages - Math.max(0, Math.floor(maxImages));
	if (remainingDrops <= 0) return context;
	return clampImages(context, {
		remainingDrops,
		inlineBytes: 0,
		byteBudget: Number.POSITIVE_INFINITY,
	});
}

/** Protect the newest user and tool-result images when they fit the request body. */
function newestImageMessages(context: Context, imageRoom: number | undefined): Set<Message> {
	const kept = new Set<Message>();
	if (imageRoom === undefined || imageRoom <= 0) return kept;
	let user: Message | undefined;
	let toolResult: Message | undefined;
	let bytes = 0;
	for (let index = context.messages.length - 1; index >= 0 && !(user && toolResult); index--) {
		const message = context.messages[index];
		if (!Array.isArray(message.content)) continue;
		const isUser = !user && message.role === "user" && message.historyRewriteAt === undefined;
		if (!isUser && (toolResult || message.role !== "toolResult")) continue;
		const messageBytes = sentImageBytes(message);
		if (isUser) user = message;
		else if (messageBytes > 0) toolResult = message;
		else continue;
		if (messageBytes === 0 || bytes + messageBytes > imageRoom) continue;
		bytes += messageBytes;
		kept.add(message);
	}
	return kept;
}

/** Explicit request limits; defaults bound unknown endpoints conservatively. */
export interface ContextImageByteLimits {
	maxInlineImageBytes?: number;
	maxRequestBytes?: number;
}

export const DEFAULT_INLINE_IMAGE_BYTES = DEFAULT_FRAME_DATA_BYTES_BUDGET * 2;
export const DEFAULT_IMAGE_REQUEST_BYTES = 8_000_000;

/** Actual Chat Completions body bytes around the image payloads. */
function otherRequestBytes(context: Context, model: Model): number {
	const messages = context.messages.map(message => {
		if (message.role === "assistant" || !Array.isArray(message.content)) return message;
		const content = message.content.map(part =>
			part.type === "image"
				? {
						...part,
						data: "",
						// Keep the data-URL envelope without validating an intentionally absent payload.
						url:
							part.url && part.url.slice(0, 5).toLowerCase() !== "data:"
								? part.url
								: `data:${part.mimeType};base64,`,
					}
				: part,
		);
		return { ...message, content } as Message;
	});
	return Buffer.byteLength(
		JSON.stringify(buildParams(model as Model<"openai-completions">, { ...context, messages })),
	);
}

/** Drop oldest inline images to fit generic or explicitly supplied request limits. */
export function clampProviderContextImageBytes(
	context: Context,
	model: Model,
	limits: ContextImageByteLimits = {},
): Context {
	if (model.api !== "openai-completions" || !model.input.includes("image")) return context;
	let inlineBytes = 0;
	for (const message of context.messages) {
		if (message.role !== "assistant") inlineBytes += sentImageBytes(message);
	}
	if (inlineBytes === 0) return context;
	const byteBudget = limits.maxInlineImageBytes ?? DEFAULT_INLINE_IMAGE_BYTES;
	const bodyLimit = limits.maxRequestBytes ?? DEFAULT_IMAGE_REQUEST_BYTES;
	const imageRoom = Math.max(0, bodyLimit - REQUEST_ENVELOPE_BYTES - otherRequestBytes(context, model));
	const budget = Math.min(byteBudget, imageRoom);
	if (inlineBytes <= budget) return context;
	return clampImages(context, {
		remainingDrops: 0,
		inlineBytes,
		byteBudget: budget,
		kept: newestImageMessages(context, Math.min(byteBudget, imageRoom)),
	});
}

/** Apply the archive frame payload budget without altering ordinary image turns. */
export function capArchiveFrameBytes(context: Context, budget = DEFAULT_FRAME_DATA_BYTES_BUDGET): Context {
	let messages: Message[] | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (message.role !== "user" || message.historyRewriteAt === undefined || !Array.isArray(message.content)) {
			continue;
		}
		const content = capFrameDataBytes(message.content, budget);
		if (content === message.content) continue;
		messages ??= context.messages.slice();
		messages[index] = { ...message, content };
	}
	return messages ? { ...context, messages } : context;
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
		let image = part;
		let reason: string | null = null;
		if (part.url) {
			if (part.url.slice(0, 5).toLowerCase() !== "data:") continue;
			try {
				const decoded = decodeDataUri(part.url);
				if (decoded) image = { ...part, ...decoded };
				else reason = "malformed data URL";
			} catch {
				reason = "malformed data URL";
			}
		}
		if (reason === null) reason = await unreadableImageReason(image);
		if (reason === null) continue;
		replaced ??= [...content];
		replaced[index] = {
			type: "text",
			text: `[image omitted: undecodable ${part.mimeType ?? "image"} data (${reason})]`,
		};
	}
	return replaced;
}

/** Replace unreadable input images; saved messages and assistant outputs stay untouched. */
async function dropUnreadableFromMessage(message: Message): Promise<Message | undefined> {
	if (message.role === "assistant" || !Array.isArray(message.content)) return undefined;
	const content = await replaceUnreadableContent(message.content);
	return content ? { ...message, content } : undefined;
}

/**
 * Last line of defence before the wire: an undecodable image makes the provider
 * reject the entire request rather than the offending block, so one bad payload
 * anywhere in history leaves the session permanently unable to send. Degrades
 * those blocks to text and leaves everything else — including the `context`
 * object itself — untouched.
 *
 * URL mirrors carry no local bytes and are left for the endpoint to fetch.
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
