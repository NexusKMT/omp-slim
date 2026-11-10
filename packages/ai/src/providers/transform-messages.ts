import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "../types";
export const MAX_TOOL_CALL_ID_LENGTH = 64;
export function normalizeToolCallId(id: string, maxLength = MAX_TOOL_CALL_ID_LENGTH): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
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
	const result: Message[] = [];
	const seen = new Set<string>();
	const pending = new Map<string, string>();
	const aliases = new Map<string, string>();
	const flush = () => {
		for (const [toolCallId, toolName] of pending)
			result.push({
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "Tool execution was interrupted; no result is available." }],
				isError: true,
				timestamp: Date.now(),
			});
		pending.clear();
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			flush();
			const content: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: redactSensitiveCredentials(block.text.toWellFormed()) });
					continue;
				}
				if (block.type !== "toolCall" || !block.id.trim() || isMalformedToolCallName(block.name)) continue;
				let id = normalizeId ? normalizeId(block.id, model, message) : block.id;
				const original = id;
				let suffix = 1;
				while (seen.has(id)) {
					const tail = `${suffixPrefix}${suffix++}`;
					id = original.slice(0, maxLength - tail.length) + tail;
				}
				seen.add(id);
				aliases.set(block.id, id);
				pending.set(id, block.name);
				const argumentsValue = redactSensitiveInObject(block.arguments).result as ToolCall["arguments"];
				content.push({ type: "toolCall", id, name: block.name, arguments: argumentsValue });
			}
			if (content.length)
				result.push({ ...message, content, providerPayload: undefined, requestControls: undefined });
		} else if (message.role === "toolResult") {
			const toolCallId = aliases.get(message.toolCallId) ?? message.toolCallId;
			if (!pending.has(toolCallId)) continue;
			pending.delete(toolCallId);
			result.push({
				...message,
				toolCallId,
				content: message.content.map(block =>
					block.type === "text"
						? { ...block, text: redactSensitiveCredentials(block.text.toWellFormed()) }
						: block,
				),
				providerMetadata: undefined,
			});
		} else {
			flush();
			result.push({
				...message,
				content:
					typeof message.content === "string"
						? redactSensitiveCredentials(message.content.toWellFormed())
						: message.content.map(block =>
								block.type === "text"
									? { ...block, text: redactSensitiveCredentials(block.text.toWellFormed()) }
									: block,
							),
				providerPayload: undefined,
			});
		}
	}
	flush();
	return result;
}
