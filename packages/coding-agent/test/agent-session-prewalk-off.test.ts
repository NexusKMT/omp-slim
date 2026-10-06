import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgPrewalkEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withEnv } from "../../ai/test/helpers";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession /prewalk off", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-prewalk-off-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	const toolSchema = type({});
	const todoTool: AgentTool<typeof toolSchema, undefined> = {
		name: "todo",
		label: "Todo",
		description: "Track tasks",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "listed" }], details: undefined };
		},
	};
	const writeTool: AgentTool<typeof toolSchema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		},
	};
	const toolRegistry = new Map<string, AgentTool>([
		[todoTool.name, todoTool as AgentTool],
		[writeTool.name, writeTool as AgentTool],
	]);

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	function createSession(responses: MockResponse[], startupArm = false) {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const settings = Settings.isolated({ "compaction.enabled": false, "prewalk.enabled": true });
		settings.setModelRole("default", `${primary.provider}/${primary.id}:medium`);
		settings.setModelRole("smol", `${target.provider}/${target.id}:medium`);
		const sessionManager = SessionManager.inMemory();
		const mock = createMockModel({ responses });
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [todoTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			thinkingLevel: Effort.Medium,
			prewalk: startupArm ? { target, thinkingLevel: Effort.Medium } : undefined,
		});
		const ctx = {
			session,
			sessionManager,
			settings,
			collabGuest: false,
			showStatus: vi.fn(),
			editor: { setText: vi.fn() },
			refreshSlashCommandState: vi.fn(),
		} as unknown as InteractiveModeContext;
		const runtime = { ctx } satisfies TuiSlashCommandRuntime;
		return { session, agent, settings, runtime, requested, primary, target };
	}

	it("cancels the startup arm so later todo and write turns keep the active model", async () => {
		const fixture = createSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			true,
		);

		await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
		await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
		expect(fixture.session.getPrewalkState()).toBeUndefined();
		expect(cfgPrewalkEnabled.get(fixture.settings)).toBe(true);

		await fixture.session.prompt("do the task");
		expect(fixture.requested).toEqual(Array(3).fill(`${fixture.primary.provider}/${fixture.primary.id}`));
		expect(fixture.session.model?.id).toBe(fixture.primary.id);
		expect(fixture.session.thinkingLevel).toBe(Effort.Medium);
	});

	it("removes an injected plan nudge from steering before the next provider request", async () => {
		const fixture = createSession([toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }]);
		await executeBuiltinSlashCommand("/prewalk", fixture.runtime);
		expect(
			fixture.agent
				.peekSteeringQueue()
				.some(message => message.role === "custom" && message.customType === "prewalk-plan"),
		).toBe(true);

		await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
		expect(
			fixture.agent
				.peekSteeringQueue()
				.some(message => message.role === "custom" && message.customType === "prewalk-plan"),
		).toBe(false);
		await fixture.session.prompt("do the task without prewalk");
		expect(fixture.requested).toEqual(Array(3).fill(`${fixture.primary.provider}/${fixture.primary.id}`));
		expect(
			fixture.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "prewalk-plan",
			),
		).toBe(false);
	});

	it("does not roll back the active model when canceled after a completed handoff", async () => {
		const fixture = createSession([
			toolCall("first-todo", "todo"),
			toolCall("first-write", "write"),
			{ content: ["first done"] },
			toolCall("second-write", "write"),
			{ content: ["second done"] },
		]);
		await executeBuiltinSlashCommand("/prewalk", fixture.runtime);
		await fixture.session.prompt("first task");
		expect(fixture.session.model?.id).toBe(fixture.target.id);

		await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
		await fixture.session.prompt("second task");
		expect(fixture.requested.slice(3)).toEqual(Array(2).fill(`${fixture.target.provider}/${fixture.target.id}`));
		expect(fixture.session.model?.id).toBe(fixture.target.id);
		expect(cfgPrewalkEnabled.get(fixture.settings)).toBe(true);
	});

	it("cancels an armed handoff even when the target has no configured credentials", async () => {
		const fixture = createSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			true,
		);
		authStorage.keys.removeRuntime("anthropic");
		try {
			await withEnv(
				{
					ANTHROPIC_API_KEY: undefined,
					ANTHROPIC_OAUTH_TOKEN: undefined,
					ANTHROPIC_FOUNDRY_API_KEY: undefined,
				},
				async () => {
					expect(modelRegistry.hasConfiguredAuth(fixture.target)).toBe(false);
					await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
					expect(fixture.session.getPrewalkState()).toBeUndefined();
					authStorage.keys.setRuntime("anthropic", "test-key");
					await fixture.session.prompt("do the task");
					expect(fixture.requested).toEqual(Array(3).fill(`${fixture.primary.provider}/${fixture.primary.id}`));
				},
			);
		} finally {
			authStorage.keys.setRuntime("anthropic", "test-key");
		}
	});

	it("cancels an existing arm even when @smol no longer resolves", async () => {
		const fixture = createSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			true,
		);
		fixture.settings.setModelRole("smol", "anthropic/missing-prewalk-model");

		await executeBuiltinSlashCommand("/prewalk off", fixture.runtime);
		expect(fixture.session.getPrewalkState()).toBeUndefined();
		await fixture.session.prompt("do the task");
		expect(fixture.requested).toEqual(Array(3).fill(`${fixture.primary.provider}/${fixture.primary.id}`));
	});

	it("rejects an extra off argument without canceling the pending handoff", async () => {
		const fixture = createSession(
			[toolCall("todo", "todo"), toolCall("write", "write"), { content: ["done"] }],
			true,
		);

		await executeBuiltinSlashCommand("/prewalk off extra", fixture.runtime);
		expect(fixture.session.getPrewalkState()?.target.id).toBe(fixture.target.id);
		await fixture.session.prompt("do the task");
		expect(fixture.requested).toEqual([
			`${fixture.primary.provider}/${fixture.primary.id}`,
			`${fixture.primary.provider}/${fixture.primary.id}`,
			`${fixture.target.provider}/${fixture.target.id}`,
		]);
		expect(fixture.session.model?.id).toBe(fixture.target.id);
	});
});
