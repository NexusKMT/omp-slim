import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentTool, AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

// Identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("speculative transform reuse", () => {
	it("applies a stateful transform exactly once for an admitted direct read", async () => {
		const schema = type({ path: "string" });
		let transformCalls = 0;
		let hookCalls = 0;
		const speculativePaths: string[] = [];
		const ordinaryPaths: string[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "read_once",
			label: "ReadOnce",
			description: "Records the path speculative execution accessed",
			parameters: schema,
			speculation: {
				finalized: {
					assess: ({ args }) =>
						typeof args.path === "string"
							? {
									eligible: true,
									effect: {
										kind: "local_read",
										resources: [{ scheme: "file", path: args.path, access: "read" }],
									},
								}
							: { eligible: false, reason: "path must be a string" },
					async execute({ args }) {
						speculativePaths.push(String(args.path));
						return {
							kind: "result",
							result: { content: [{ type: "text", text: "speculative result" }] },
							isError: false,
						};
					},
				},
			},
			async execute(_toolCallId, args) {
				ordinaryPaths.push(args.path);
				return { content: [{ type: "text", text: "ordinary result" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "read-once-1", name: "read_once", arguments: { path: "/tmp/spec-once" } },
					],
				},
				{ content: ["done"] },
			],
		});

		await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				transformToolCallArguments: args => ({ ...args, path: `${String(args.path)}#t${++transformCalls}` }),
				beforeToolCall: async () => {
					hookCalls++;
				},
				speculativeToolExecution: {
					enabled: true,
					host: { authorize: () => ({ allowed: true, deferBeforeToolCall: true }) },
				},
			},
			undefined,
			mock.stream,
		).result();

		// The beforeToolCall gate still runs: reuse must not bypass hook policy.
		expect(hookCalls).toBe(1);
		// Admission ran the stateful transform once; reconciliation and dispatch
		// must reuse that result instead of applying it again.
		expect(transformCalls).toBe(1);
		expect(speculativePaths).toEqual(["/tmp/spec-once#t1"]);
		expect(ordinaryPaths).toEqual([]);
	});
});
