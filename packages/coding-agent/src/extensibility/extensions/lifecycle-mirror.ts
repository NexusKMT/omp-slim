/** Map core session events into the extension event contract. */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "../../session/agent-session";
import type {
	AgentEndEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	TodoReminderEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./types";
import type { GoalUpdatedEvent } from "../shared-events";

/**
 * Clone one top-level notification field without ever returning an object
 * owned by the live session. Most values take the lossless structured-clone
 * path. If a third-party metadata object contains functions or other
 * unsupported values, JSON sanitization drops those values; a cyclic/non-JSON
 * value finally degrades to a descriptive string rather than retaining a
 * shared mutable reference.
 */
function cloneNotificationField(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return JSON.parse(json) as unknown;
	} catch {}
	return String(value);
}

/** Build a detached, notification-only snapshot of an `AgentMessage`. */
function cloneMessageNotification(message: AgentMessage): AgentMessage {
	const snapshot: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(message)) {
		const descriptor = Object.getOwnPropertyDescriptor(message, key);
		if (!descriptor?.enumerable) continue;
		snapshot[key] = cloneNotificationField(Reflect.get(message, key));
	}
	return snapshot as unknown as AgentMessage;
}

/** Extension events `extensionEventFromSessionEvent` maps onto. */
export type MappedExtensionEvent =
	| { type: "agent_start" }
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| RetryFallbackAppliedEvent
	| RetryFallbackSucceededEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent;
/**
 * Map a session event onto the extension event `AgentSession` emits for it
 * (see `#emitExtensionEvent` there). Returns `null` for events with no
 * extension counterpart, so callers skip the runner entirely instead of
 * emitting a no-op.
 *
 * @param event Session event (emitted by the local session).
 * @param turnIndex Zero-based turn counter the caller owns; `AgentSession`
 *   resets it on `agent_start`, the session
 *   does the same for its mirrored stream.
 */
export function extensionEventFromSessionEvent(
	event: AgentSessionEvent,
	turnIndex: number,
): MappedExtensionEvent | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return {
				type: "agent_end",
				messages: event.messages,
				willContinue: event.isTerminal === false ? true : undefined,
				...(event.isTerminal === false && event.awaitingAsyncWork === true ? { awaitingAsyncWork: true } : {}),
			};
		case "turn_start":
			return { type: "turn_start", turnIndex, timestamp: Date.now() };
		case "turn_end":
			return {
				type: "turn_end",
				turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
		case "message_start":
			return { type: "message_start", message: event.message };
		case "message_update":
			return { type: "message_update", message: event.message, assistantMessageEvent: event.assistantMessageEvent };
		case "message_end": {
			// `message_end` is a notification, not a context-rewrite hook. Detach its
			// payload so an async observer that mutates the event after an `await`
			// cannot race the owner's use of the same reference — locally that is
			// mid-run maintenance, in a transcript it is the same
			// object is rendered from.
			const messageEnd: MessageEndEvent = {
				type: "message_end",
				message: cloneMessageNotification(event.message),
			};
			return messageEnd;
		}
		case "tool_execution_start": {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			return extensionEvent;
		}
		case "tool_execution_update": {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			return extensionEvent;
		}
		case "tool_execution_end": {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			return extensionEvent;
		}
		case "auto_compaction_start":
			return { type: "auto_compaction_start", reason: event.reason, action: event.action };
		case "auto_compaction_end":
			return {
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				retryErrors: event.retryErrors,
			};
		case "retry_fallback_applied":
			return {
				type: "retry_fallback_applied",
				from: event.from,
				to: event.to,
				role: event.role,
				reason: event.reason,
			};
		case "retry_fallback_succeeded":
			return { type: "retry_fallback_succeeded", model: event.model, role: event.role };
		case "ttsr_triggered":
			return { type: "ttsr_triggered", rules: event.rules };
		case "todo_reminder":
			return {
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			};
		case "goal_updated":
			return { type: "goal_updated", goal: event.goal, state: event.state };
		default:
			return null;
	}
}
