import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage, UserMessage } from "../types";
import { kSyntheticUser, type SyntheticUserCarrier } from "../utils/block-symbols";
export const MAX_TOOL_CALL_ID_LENGTH = 64;
export function normalizeToolCallId(id: string, maxLength = MAX_TOOL_CALL_ID_LENGTH): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
}
/** Append a deterministic duplicate suffix without exceeding the wire id limit. */
export function appendDuplicateSuffix(originalId: string, suffix: string, maxLength: number): string {
	return originalId.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
}
export function isValidToolCallId(id: string): boolean {
	return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}
export function isMalformedToolCallName(name: unknown, allowedName = /^[a-zA-Z0-9_-]+$/, maxLength = 64): boolean {
	return typeof name !== "string" || name.length > maxLength || !allowedName.test(name);
}
export function shouldDropTruncatedThinkingOnlyAssistant(message: AssistantMessage): boolean {
	return !message.content.some(block => block.type === "text" || block.type === "toolCall");
}
export function isSurvivingAssistant(message: AssistantMessage): boolean {
	return !shouldDropTruncatedThinkingOnlyAssistant(message);
}
export function isSameModelTurn(message: AssistantMessage, model: Model): boolean {
	return message.api === model.api && message.provider === model.provider && message.model === model.id;
}
export const SENSITIVE_TOKEN_RE =
	/(?<![a-zA-Z0-9_*-])(gh[opusr]_[a-zA-Z0-9_*]{36,}|github_pat_[a-zA-Z0-9_*]{36,}|glpat-[a-zA-Z0-9_*-]{20,}|sk-proj-[a-zA-Z0-9_*-]{36,}|sk-ant-[a-zA-Z0-9_*-]{36,}|sk-[a-zA-Z0-9_*-]{48,})(?![a-zA-Z0-9_*-])/gi;

function hasPlausibleCredentialEntropy(token: string): boolean {
	const lower = token.toLowerCase();
	const prefixLength = lower.startsWith("github_pat_")
		? "github_pat_".length
		: lower.startsWith("glpat-")
			? "glpat-".length
			: lower.startsWith("sk-proj-")
				? "sk-proj-".length
				: lower.startsWith("sk-ant-")
					? "sk-ant-".length
					: lower.startsWith("gh")
						? 4
						: 3;
	const secret = token.slice(prefixLength);
	if (/^\*+$/.test(secret)) return true;
	return [/[a-z]/, /[A-Z]/, /\d/, /[_-]/].filter(pattern => pattern.test(secret)).length >= 2;
}

/**
 * Whether outbound credential-pattern redaction is active outside any
 * {@link withCredentialRedaction} scope. Off by default; hosts opt in
 * explicitly (the coding agent wires this to the `secrets.enabled` setting).
 */
let credentialRedactionEnabled = false;

/** Per-request override of {@link credentialRedactionEnabled}; see {@link withCredentialRedaction}. */
const credentialRedactionScope = new AsyncLocalStorage<boolean>();

/** Redaction policy for the request being built: its scope's, else the process-wide switch. */
function isCredentialRedactionActive(): boolean {
	return credentialRedactionScope.getStore() ?? credentialRedactionEnabled;
}

/**
 * Toggle process-wide outbound credential-pattern redaction (requests outside
 * any {@link withCredentialRedaction} scope). When disabled (the default),
 * {@link redactSensitiveCredentials} and {@link redactSensitiveInObject} are
 * pass-throughs and outbound messages/system prompts leave the process
 * unmodified.
 */
export function configureCredentialRedaction(enabled: boolean): void {
	credentialRedactionEnabled = enabled;
}

/**
 * Runs `fn` with outbound credential-pattern redaction forced on or off for
 * every request it starts (including the async work those requests spawn),
 * overriding {@link configureCredentialRedaction}. Lets concurrent sessions in
 * one process each apply their own policy.
 */
export function withCredentialRedaction<T>(enabled: boolean, fn: () => T): T {
	return credentialRedactionScope.run(enabled, fn);
}

export function redactSensitiveCredentials(text: string): string {
	if (!isCredentialRedactionActive()) return text;
	return text.replace(SENSITIVE_TOKEN_RE, match => {
		if (!hasPlausibleCredentialEntropy(match)) return match;
		const lower = match.toLowerCase();
		if (lower.startsWith("gh")) {
			return "[github_token_redacted]";
		}
		if (lower.startsWith("gl")) {
			return "[gitlab_token_redacted]";
		}
		if (lower.startsWith("sk-ant-")) {
			return "[anthropic_token_redacted]";
		}
		if (lower.startsWith("sk")) {
			return "[openai_token_redacted]";
		}
		return "[token_redacted]";
	});
}

export function redactSensitiveInObject(val: unknown): { result: unknown; changed: boolean } {
	if (!isCredentialRedactionActive()) return { result: val, changed: false };
	if (typeof val === "string") {
		const redacted = redactSensitiveCredentials(val);
		return { result: redacted, changed: redacted !== val };
	}
	// Copy-on-write: history is re-redacted on every request and almost never
	// contains a credential, so unchanged subtrees are returned as-is.
	if (Array.isArray(val)) {
		let result: unknown[] | undefined;
		for (let i = 0; i < val.length; i++) {
			const sub = redactSensitiveInObject(val[i]);
			if (!sub.changed) continue;
			result ??= val.slice();
			result[i] = sub.result;
		}
		return result ? { result, changed: true } : { result: val, changed: false };
	}
	if (val !== null && typeof val === "object") {
		const entries = Object.entries(val);
		let result: Record<string, unknown> | undefined;
		for (const [k, v] of entries) {
			const sub = redactSensitiveInObject(v);
			if (!sub.changed) continue;
			result ??= Object.fromEntries(entries);
			result[k] = sub.result;
		}
		return result ? { result, changed: true } : { result: val, changed: false };
	}
	return { result: val, changed: false };
}

/** Normalize replayable text/tool history without translating provider-native payloads. */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	maxLength = MAX_TOOL_CALL_ID_LENGTH,
	suffixPrefix = "_dup",
): Message[] {
	const normalized: Message[] = [];
	const aliases = new Map<string, string>();
	const malformedQueues = new Map<string, boolean[]>();
	const redactContent = (content: ToolResultMessage["content"]): ToolResultMessage["content"] =>
		content.map(block =>
			block.type === "text" ? { ...block, text: redactSensitiveCredentials(block.text.toWellFormed()) } : block,
		);
	for (const message of messages) {
		if (message.role === "assistant") {
			malformedQueues.clear();
			const content: AssistantMessage["content"] = [];
			let survives = false;
			for (const block of message.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: redactSensitiveCredentials(block.text.toWellFormed()) });
					survives = true;
					continue;
				}
				// Preserve thinking blocks for the encoder: DeepSeek-class
				// endpoints require reasoning replay, and the completions
				// encoder echoes only reasoning-source-signed blocks.
				if (block.type === "thinking") {
					content.push(block);
					continue;
				}
				if (block.type !== "toolCall") continue;
				const malformed = !block.id.trim() || isMalformedToolCallName(block.name);
				const queue = malformedQueues.get(block.id) ?? [];
				queue.push(malformed);
				malformedQueues.set(block.id, queue);
				if (malformed) continue;
				const id = normalizeId ? normalizeId(block.id, model, message) : block.id;
				aliases.set(block.id, id);
				let args: unknown = block.arguments;
				if (typeof args === "string") {
					try {
						args = JSON.parse(args);
					} catch {
						args = {};
					}
				}
				if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
				content.push({
					type: "toolCall",
					id,
					name: block.name,
					arguments: redactSensitiveInObject(args).result as ToolCall["arguments"],
				});
				survives = true;
			}
			if (survives)
				normalized.push({ ...message, content, providerPayload: undefined, requestControls: undefined });
		} else if (message.role === "toolResult") {
			const queue = malformedQueues.get(message.toolCallId);
			if (queue?.shift()) continue;
			normalized.push({
				...message,
				toolCallId: aliases.get(message.toolCallId) ?? message.toolCallId,
				content: redactContent(message.content),
				providerMetadata: undefined,
			});
		} else {
			malformedQueues.clear();
			normalized.push({
				...message,
				content:
					typeof message.content === "string"
						? redactSensitiveCredentials(message.content.toWellFormed())
						: redactContent(message.content),
				providerPayload: undefined,
			});
		}
	}
	// An id may repeat in one turn or be reused after compaction. Queue rewrites
	// within a turn; a later turn reusing the id supersedes an unfinished call.
	const seen = new Set<string>();
	const rewrites = new Map<string, string[]>();
	const validIds = new Set<string>();
	const realResults = new Map<string, { index: number; message: ToolResultMessage }[]>();
	const transformed = normalized.map((message, index): Message => {
		if (message.role === "toolResult") {
			const id = rewrites.get(message.toolCallId)?.shift() ?? message.toolCallId;
			const rewritten = { ...message, toolCallId: id };
			const entries = realResults.get(id) ?? [];
			entries.push({ index, message: rewritten });
			realResults.set(id, entries);
			return rewritten;
		}
		if (message.role !== "assistant") return message;
		const touched = new Set<string>();
		const content = message.content.map(block => {
			if (block.type !== "toolCall") return block;
			if (!touched.has(block.id)) {
				touched.add(block.id);
				rewrites.delete(block.id);
			}
			let id = block.id;
			let duplicate = 1;
			while (seen.has(id)) id = appendDuplicateSuffix(block.id, `${suffixPrefix}${duplicate++}`, maxLength);
			seen.add(id);
			validIds.add(id);
			const queue = rewrites.get(block.id) ?? [];
			queue.push(id);
			rewrites.set(block.id, queue);
			return { ...block, id };
		});
		return { ...message, content };
	});
	// Chat requires every tool call's results before the next conversational
	// message. Pull a delayed real result forward, but never steal an earlier
	// orphan or a later turn's reused-id result.
	const result: Message[] = [];
	let openWindow = new Set<string>();
	for (let index = 0; index < transformed.length; index++) {
		const message = transformed[index]!;
		if (message.role === "assistant") {
			result.push(message);
			const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			openWindow = new Set(calls.map(call => call.id));
			for (const call of calls) {
				const real = realResults.get(call.id)?.find(entry => entry.index > index);
				result.push(
					real?.message ?? {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [
							{
								type: "text",
								text:
									message.stopReason === "error" || message.stopReason === "aborted"
										? "aborted"
										: "No result provided",
							},
						],
						isError: true,
						timestamp: message.timestamp,
					},
				);
			}
		} else if (message.role === "toolResult") {
			if (validIds.has(message.toolCallId)) {
				openWindow.delete(message.toolCallId);
				continue;
			}
			if (openWindow.size) continue;
			const text = message.content
				.filter(block => block.type === "text" && block.text.trim())
				.map(block => (block.type === "text" ? block.text : ""))
				.join("\n");
			if (!text) continue;
			const errorAttr = message.isError ? ' is-error="true"' : "";
			const note: UserMessage & SyntheticUserCarrier = {
				role: "user",
				content: `<stale-tool-result tool="${message.toolName}" id="${message.toolCallId}"${errorAttr}>\n${text}\n</stale-tool-result>`,
				timestamp: message.timestamp,
			};
			note[kSyntheticUser] = true;
			result.push(note);
		} else {
			openWindow.clear();
			result.push(message);
		}
	}
	return result;
}
