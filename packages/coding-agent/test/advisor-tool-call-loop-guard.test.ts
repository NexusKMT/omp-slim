import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Advisor-visible tool that fails the same way on every call. */
const failingReadTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Mock read tool",
	parameters: type({ "path?": "string" }),
	execute: async () => ({
		content: [{ type: "text" as const, text: "ENOENT: no such file or directory" }],
		isError: true,
	}),
};

describe("advisor tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-call-loop-guard-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	/**
	 * Live advisor agent built through the real `SessionAdvisors` path, driven by
	 * a stream that repeats one identical failing tool call forever.
	 */
	function createAdvisor(guardSettings: Record<string, unknown>): { advisor: Agent; contexts: Context[] } {
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] });
		const advisorMock = createMockModel({ provider: "anthropic" });
		const contexts: Context[] = [];
		let turn = 0;
		const advisorStreamFn: typeof advisorMock.stream = (_model, context) => {
			contexts.push(context);
			// Stop once the corrective lands so a broken guard fails on the
			// assertion rather than looping until the test times out.
			const repeating = turn < 8 && !JSON.stringify(context.messages).includes("tool_call_loop_detected");
			turn++;
			const message: AssistantMessage = repeating
				? {
						role: "assistant",
						content: [{ type: "toolCall", id: `tc-${turn}`, name: "read", arguments: { path: "missing.ts" } }],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					}
				: {
						role: "assistant",
						content: [{ type: "text", text: "Stopped repeating." }],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: repeating ? "toolUse" : "stop", message });
			});
			return stream;
		};
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, ...guardSettings });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [failingReadTool],
			advisorStreamFn,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);
		return { advisor, contexts };
	}

	it("redirects the advisor's own repeated tool call and reaches its next request", async () => {
		const { advisor, contexts } = createAdvisor({
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 3,
		});

		await advisor.prompt("review the current update");

		// Threshold 3 => two clean turns, the third trips the bound.
		const redirects = contexts.filter(context =>
			JSON.stringify(context.messages).includes("tool_call_loop_detected"),
		);
		expect(redirects).toHaveLength(1);
		const delivered = JSON.stringify(redirects[0]!.messages);
		expect(delivered).toContain("You called `read` 3 consecutive times");
		expect(delivered).toContain("ENOENT: no such file or directory");
		// The advisor's context uses the default LLM converter, so the corrective
		// only survives as an LLM-native role.
		expect(advisor.state.messages.filter(message => message.role === "custom")).toHaveLength(0);
		expect(advisor.state.messages.at(-1)?.role).toBe("assistant");
	});

	it("leaves the advisor unbounded when the shared loop guard is disabled", async () => {
		const { advisor, contexts } = createAdvisor({ "model.toolCallLoopGuard.enabled": false });

		await advisor.prompt("review the current update");

		expect(contexts.some(context => JSON.stringify(context.messages).includes("tool_call_loop_detected"))).toBe(
			false,
		);
		// Nine requests: eight repeated tool-call turns plus the final stop.
		expect(contexts).toHaveLength(9);
	});
});
