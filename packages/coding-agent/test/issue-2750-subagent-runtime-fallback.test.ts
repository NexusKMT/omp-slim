import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ServingModel } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createSessionDefaults } from "./helpers/session-defaults";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/** Emits a settled result after the attribution fixture completes its turn. */
function createYieldingSession(beforeYield?: () => Promise<void>): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: model("primary", "bad-runtime-model"),
		servingModel: { selector: "primary/bad-runtime-model", isFallback: false } as ServingModel | undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			// Broadcast per event, not per subscriber: every observer must see the
			// same session state at the same point in the sequence.
			const emit = (event: { type: string; [key: string]: unknown }): void => {
				for (const listener of listeners) listener(event);
			};
			await beforeYield?.();

			emit({
				type: "tool_execution_end",
				toolCallId: "tool-yield",
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
				isError: false,
			});
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const { level, collide } of [
		{ level: undefined, collide: false },
		{ level: ThinkingLevel.High, collide: false },
		{ level: undefined, collide: true },
	]) {
		it(`keeps literal suffix attribution distinct from thinking (${collide ? "colliding selector" : (level ?? "unset")})`, async () => {
			const literal = model("custom", "coding-router:max");
			const snapshots: AgentProgress[] = [];
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				if (!options?.model) throw new Error("Expected resolved model");
				let activeModel = options.model;
				let activeLevel: ThinkingLevel | undefined = level;
				const recovery = new TurnRecovery({
					model: () => activeModel,
					thinkingLevel: () => activeLevel,
					sessionManager: { getSessionId: () => "literal-model" },
					settings: Settings.isolated({}),
					modelRegistry: {},
				} as unknown as TurnRecoveryHost);
				const session = createYieldingSession(async () => {
					if (collide) {
						// Same concatenated selector, different identity and reasoning.
						activeModel = model("custom", "coding-router");
						activeLevel = ThinkingLevel.Max;
					}
					await recovery.onAssistantSettledSuccessfully({
						role: "assistant",
						content: [{ type: "text", text: "literal model produced this answer" }],
						stopReason: "stop",
					} as AssistantMessage);
					// A newly armed model must not steal the settled answer's identity.
					activeModel = model("custom", "unserved-candidate");
				});
				Object.defineProperty(session, "servingModel", { get: () => recovery.servingModel });
				expect(recovery.servingModel?.modelIdentity).toBe("custom/coding-router:max");
				expect(recovery.servingModel?.thinkingLevel).toBe(level);
				return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
			});
			const settings = Settings.isolated({});
			settings.setModelRole("default", "custom/coding-router:max");
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: "work",
				index: 0,
				id: "literal-model",
				parentModel: literal,
				settings,
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [literal],
					getApiKey: async () => "test-key",
				} as never,
				onProgress: progress => snapshots.push({ ...progress }),
				enableLsp: false,
			});
			const expectedSelector = level ? `custom/coding-router:max:${level}` : "custom/coding-router:max";
			const latest = snapshots.findLast(progress => progress.resolvedModel !== undefined);
			expect(latest?.resolvedModelIdentity).toBe(collide ? "custom/coding-router" : "custom/coding-router:max");
			expect(latest?.resolvedThinkingLevel).toBe(collide ? ThinkingLevel.Max : level);
			expect(result.resolvedModel).toBe(expectedSelector);
			expect(result.resolvedModelIdentity).toBe(collide ? "custom/coding-router" : "custom/coding-router:max");
			expect(result.resolvedThinkingLevel).toBe(collide ? ThinkingLevel.Max : level);
			expect(result.resolvedModelIsFallback).toBeFalsy();
		});
	}
});

describe("subagents retry one model on a real provider error", () => {
	const MOCK_API_SOURCE = "test/issue-2750-subagent-runtime-fallback";
	const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const OVERLOADED = "overloaded_error: provider returned error 503";
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	function restoreEnvValue(key: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[key];
			delete Bun.env[key];
			return;
		}
		process.env[key] = value;
		Bun.env[key] = value;
	}

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-empty-fallback-chain-"));
		// Project discovery walks up from cwd to os.homedir(); keep both inside the fake HOME.
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registerMockApi(MOCK_API_SOURCE);
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		// The child opened agent.db and models.db under root; Windows cannot delete open files.
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	/**
	 * Spawns a child on the current model, which fails each request with a retryable error.
	 * Old settings still name an available fallback that must never receive a request.
	 */
	async function runPinnedWorker(id: string) {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("primary", "test-key");
		authStorage.keys.setRuntime("fallback", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const primary = createMockModel({
			provider: "primary",
			id: "bad-runtime-model",
			handler: () => ({ throw: OVERLOADED }),
		});
		const fallback = createMockModel({
			provider: "fallback",
			id: "working-model",
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["ok"] }
					: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "recovered" } }] },
		});
		const mocks = [primary, fallback];
		const find = modelRegistry.find.bind(modelRegistry);
		vi.spyOn(modelRegistry, "find").mockImplementation(
			(provider, modelId) => mocks.find(m => m.provider === provider && m.id === modelId) ?? find(provider, modelId),
		);
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(
			provider => mocks.some(m => m.provider === provider) || hasProvider(provider),
		);
		const available = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...available(kind)]);
		try {
			const result = await runSubprocess({
				cwd: path.join(root, "home", "work"),
				agent: {
					name: "pinned-worker",
					description: "test",
					systemPrompt: "test",
					tools: ["read"],
					source: "bundled",
					model: ["@pinned-worker"],
				},
				task: "work",
				index: 0,
				id,
				parentModel: primary,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.baseDelayMs": 1,
					"retry.maxRetries": 2,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: {
						default: "primary/bad-runtime-model",
						"pinned-worker": "primary/bad-runtime-model",
					},
					"retry.fallbackChains": {
						default: ["fallback/working-model"],
					},
				}),
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			return { result, primaryRequests: primary.calls.length, fallbackRequests: fallback.calls.length };
		} finally {
			authStorage.close();
		}
	}

	it("exhausts same-model retries without contacting a legacy configured fallback", async () => {
		const { result, primaryRequests, fallbackRequests } = await runPinnedWorker("LegacyFallbackChain");
		expect(primaryRequests).toBe(3);
		expect(fallbackRequests).toBe(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.resolvedModelIsFallback).toBeFalsy();
		expect(result.error).toContain(OVERLOADED);
	});
});
