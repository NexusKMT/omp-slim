import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const noopSchema = z.object({});
const noopTool: AgentTool<typeof noopSchema, undefined> = {
	name: "noop",
	label: "No-op",
	description: "Continue the scripted tool loop",
	parameters: noopSchema,
	async execute() {
		return { content: [{ type: "text", text: "continued" }], details: undefined };
	},
};

const DEAD_END_WARNING = "Compaction freed too little context to make progress";

describe("AgentSession mid-turn compaction dead-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
	});

	it("attempts and warns once per oversized tool-loop turn", async () => {
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		tempDir = TempDir.createSync("@pi-mid-turn-compaction-dead-end-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "noop-1", name: "noop", arguments: {} }],
					usage: { input: 190_000 },
				},
				{
					content: [{ type: "toolCall", id: "noop-2", name: "noop", arguments: {} }],
					usage: { input: 190_000 },
				},
				{ content: ["done"] },
				{
					content: [{ type: "toolCall", id: "noop-3", name: "noop", arguments: {} }],
					usage: { input: 190_000 },
				},
				{
					content: [{ type: "toolCall", id: "noop-4", name: "noop", arguments: {} }],
					usage: { input: 190_000 },
				},
				{ content: ["done again"] },
			],
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([mock]);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [noopTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 100_000,
			"compaction.midTurnEnabled": true,
			"compaction.autoContinue": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[noopTool.name, noopTool]]),
		});
		const notices: string[] = [];
		let compactionStarts = 0;
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			if (event.type === "auto_compaction_start") compactionStarts++;
		});

		await session.prompt("Run both tools before answering");

		expect(mock.calls).toHaveLength(3);
		expect(notices).toEqual([expect.stringContaining(DEAD_END_WARNING)]);
		expect(compactionStarts).toBe(1);

		await session.prompt("Run two more tools before answering");

		expect(mock.calls).toHaveLength(6);
		expect(notices).toEqual([expect.stringContaining(DEAD_END_WARNING), expect.stringContaining(DEAD_END_WARNING)]);
		expect(compactionStarts).toBe(2);
	});
});
