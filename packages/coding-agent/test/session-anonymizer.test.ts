import { describe, expect, test } from "bun:test";
import { SessionAnonymizer } from "../src/session/session-anonymizer";

const SECRET_WORDS = ["acme", "hunter2", "invoiceParser", "Probe", "alice", "launch codes"];

describe("SessionAnonymizer", () => {
	test("redacts turn content, keeps metadata, and maps tool args consistently across copies", () => {
		const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.01 } };
		const records = [
			{
				type: "session",
				version: 3,
				id: "01a0c9ac-8c2d",
				timestamp: "2026-09-22T15:12:03.629Z",
				cwd: "/home/alice/acme",
			},
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: "2026-09-22T15:12:04.000Z",
				message: { role: "user", content: [{ type: "text", text: "the launch codes are hunter2" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "b1b2c3d4",
				parentId: "a1b2c3d4",
				timestamp: "2026-09-22T15:12:05.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "look for invoiceParser" },
						{
							type: "toolCall",
							id: "toolu_01MNY3aqvM6YV4Bg",
							name: "grep",
							arguments: {
								pattern: "invoiceParser",
								path: "/home/alice/acme/src/billing.ts:10-20",
								case: "smart",
							},
						},
						{
							type: "toolCall",
							id: "toolu_02XYZ9abcd",
							name: "task",
							arguments: { tasks: [{ name: "Probe", agent: "scout" }] },
						},
						{ type: "toolCall", id: "toolu_03XYZ9abcd", name: "read", arguments: { path: "agent://Probe" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage,
					stopReason: "toolUse",
					providerPayload: {
						items: [
							{
								type: "function_call",
								name: "grep",
								call_id: "call_01a0bf7134",
								arguments: JSON.stringify({
									pattern: "invoiceParser",
									path: "/home/alice/acme/src/billing.ts",
								}),
							},
						],
					},
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				id: "c1b2c3d4",
				parentId: "b1b2c3d4",
				timestamp: "2026-09-22T15:12:05.100Z",
				data: { toolCallId: "toolu_01MNY3aqvM6YV4Bg", toolName: "grep", args: { pattern: "invoiceParser" } },
			},
			{
				type: "message",
				id: "d1b2c3d4",
				parentId: "c1b2c3d4",
				timestamp: "2026-09-22T15:12:06.000Z",
				message: {
					role: "toolResult",
					toolCallId: "toolu_01MNY3aqvM6YV4Bg",
					toolName: "grep",
					content: [{ type: "text", text: "src/billing.ts:12: export function invoiceParser() {}" }],
					details: { matchCount: 1, searchPath: "/home/alice/acme" },
					isError: false,
				},
			},
		];

		const anonymizer = new SessionAnonymizer();
		const anonymized = records.map(record => anonymizer.entry(record)) as Record<string, any>[];
		const serialized = JSON.stringify(anonymized);
		for (const word of SECRET_WORDS) expect(serialized).not.toContain(word);

		const [header, user, assistant, start, toolResult] = anonymized;
		expect(header).toMatchObject({ type: "session", id: "01a0c9ac-8c2d", timestamp: "2026-09-22T15:12:03.629Z" });
		expect(header.cwd).toMatch(/^\/home\/seg\d+\/seg\d+$/);

		expect(user.message.content[0].text).toMatch(/^\[redacted #\d+: 28 chars, 1 line\]$/);
		expect(assistant.message).toMatchObject({
			model: "claude-opus-5-5",
			provider: "anthropic",
			usage,
			stopReason: "toolUse",
		});

		const [thinking, grep, task, read] = assistant.message.content;
		expect(thinking.thinking).toMatch(/^\[redacted #\d+: 22 chars, 1 line\]$/);
		expect(grep).toMatchObject({ type: "toolCall", id: "toolu_01MNY3aqvM6YV4Bg", name: "grep" });
		expect(grep.arguments.pattern).toMatch(/^PLACEHOLDER_\d+$/);
		expect(grep.arguments.case).toBe("smart");
		expect(grep.arguments.path).toBe(
			`${header.cwd}/src/seg${grep.arguments.path.match(/src\/seg(\d+)/)[1]}.ts:10-20`,
		);

		// Same original → same token everywhere: wire JSON string, execution log, and the agent name/URI pair.
		const wireArgs = JSON.parse(assistant.message.providerPayload.items[0].arguments);
		expect(wireArgs).toEqual({ pattern: grep.arguments.pattern, path: grep.arguments.path.replace(/:10-20$/, "") });
		expect(start.data.args.pattern).toBe(grep.arguments.pattern);
		const agentIndex = task.arguments.tasks[0].name.replace("PLACEHOLDER_", "");
		expect(task.arguments.tasks[0].agent).toBe("scout");
		expect(read.arguments.path).toBe(`agent://seg${agentIndex}`);

		expect(toolResult.message.content[0].text).toMatch(/^\[redacted #\d+: 53 chars, 1 line\]$/);
		expect(toolResult.message.details).toEqual({ matchCount: 1, searchPath: header.cwd });
	});

	test("rewrites shell commands keeping programs, flags, and operators", () => {
		const anonymizer = new SessionAnonymizer();
		const out = anonymizer.command(
			`git --no-pager log --oneline -3 acme 2>&1 | grep "hunter2" > /tmp/acme/out.txt && bun run build`,
		);
		const acme = anonymizer.placeholder("acme");
		expect(out).toBe(
			`git --no-pager log --oneline -3 ${acme} 2>&1 | grep "${anonymizer.placeholder("hunter2")}" > /tmp/seg${acme.slice(12)}/out.txt && bun run ${anonymizer.placeholder("build")}`,
		);
	});
});
