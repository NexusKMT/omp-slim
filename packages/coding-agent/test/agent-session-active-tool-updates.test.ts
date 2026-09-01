/**
 * Focus rebuilds replay `AgentSession.activeToolExecutionUpdates()` to restore a
 * live task board (#10446). These transient snapshots must not accumulate: a
 * detached background task streams its terminal state as a `tool_execution_update`
 * (async.state completed/failed) with no second `tool_execution_end`, and `/new`
 * or a session switch reuses tool-call ids. Both would otherwise let a finished
 * board linger and replay into an unrelated call (#10447 review).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function taskUpdate(state: "running" | "completed" | "failed"): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId: "task-1",
		toolName: "task",
		args: {},
		partialResult: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 5,
				progress: [],
				async: { state, jobId: "job-1", type: "task" },
			},
		},
	} as AgentEvent;
}

describe("AgentSession.activeToolExecutionUpdates cache lifecycle", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	it("evicts a background task snapshot once its async state settles", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);

		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);
	});

	it("clears cached snapshots across a new session so a reused id cannot replay", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(1);
		expect(await session.newSession()).toBe(true);
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);
	});
});
