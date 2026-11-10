import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Shared factory for building a minimal mock `AssistantMessage`
 * used by AgentSession test suites.
 */
export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export { createInMemoryAuthStorage } from "./auth-storage";

/**
 * Make `todo` the session's active tool. Todo stop reminders only fire while
 * the todo tool is active, so reminder tests on tool-less sessions need this.
 */
export function activateTodoTool(session: AgentSession, cwd: string): void {
	session.agent.setTools([
		new TodoTool({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: session.settings,
		}),
	]);
}
