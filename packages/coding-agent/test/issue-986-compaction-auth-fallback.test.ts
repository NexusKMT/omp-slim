import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { getTestModel } from "./helpers/model-fixtures";
import { assistantMsg, userMsg } from "./utilities";

import { cfgRetryBaseDelayMs, cfgRetryEnabled, cfgRetryMaxRetries } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("issue #986 compaction auth errors on the current model", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: { configureFallbackAuth?: boolean }) {
		const bundledCurrentModel = getTestModel(
			"openai-codex",
			model => model.api === "openai-codex-responses" && model.input.includes("text"),
		);
		const currentModel = {
			...bundledCurrentModel,
			remoteCompaction: {
				...bundledCurrentModel.remoteCompaction,
				enabled: true,
				endpoint: "https://compact.example/v1/responses/compact",
			},
		};
		const fallbackModel = getTestModel(
			"anthropic",
			model => model.api === "anthropic-messages" && model.input.includes("text"),
		);
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote", "soft"],
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "codex-token");
		if (options?.configureFallbackAuth !== false) {
			authStorage.keys.setRuntime(fallbackModel.provider, "anthropic-token");
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		return { currentModel: session.model!, fallbackModel };
	}

	async function createAutoNativeSession(options?: { includeSoftFallback?: boolean }) {
		const currentModel = getTestModel(
			"openai",
			model =>
				model.api === "openai-responses" &&
				model.input.includes("text") &&
				(model.contextWindow ?? 0) > 0 &&
				compactionModule.shouldUseProviderNativeCompaction(model, {
					remoteEnabled: true,
					remoteStreamingV2Enabled: true,
				}),
		);
		const sameProviderModel = getTestModel(
			"openai",
			model =>
				model.id !== currentModel.id &&
				model.api === "openai-responses" &&
				(model.requestModelId ?? model.id) !== (currentModel.requestModelId ?? currentModel.id) &&
				model.input.includes("text") &&
				compactionModule.shouldUseProviderNativeCompaction(model, {
					remoteEnabled: true,
					remoteStreamingV2Enabled: true,
				}),
		);
		const crossProviderModel = getTestModel(
			"anthropic",
			model => model.api === "anthropic-messages" && model.input.includes("text"),
		);

		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": options?.includeSoftFallback ? ["remote", "soft"] : ["remote"],
		});
		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "openai-token");
		authStorage.keys.setRuntime(crossProviderModel.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel, sameProviderModel, crossProviderModel]);
		const apiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const triggerAutoCompaction = async (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") resolve();
			});
			const contextWindow = currentModel.contextWindow;
			if (!contextWindow) throw new Error("Expected current model context window");
			const assistant = {
				...assistantMsg("threshold reached"),
				api: currentModel.api,
				provider: currentModel.provider,
				model: currentModel.id,
				usage: {
					input: contextWindow,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: contextWindow + 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await promise;
			await session.waitForIdle();
		};

		return { apiKeySpy, crossProviderModel, currentModel, sameProviderModel, triggerAutoCompaction };
	}

	it("reports native transport failure without trying another available model", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession();
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(
				new compactionModule.NativeCompactionError(new Error("native compaction transport failed")),
			);
		let errorMessage: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") errorMessage = event.errorMessage;
		});

		await triggerAutoCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]).toBe(currentModel);
		expect(errorMessage).toContain("native compaction transport failed");
		expect(session.model).toBe(currentModel);
	});

	it("retries a transient native compaction failure on the same candidate", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession();
		cfgRetryEnabled.set(session.settings, true);
		cfgRetryBaseDelayMs.set(session.settings, 1);
		cfgRetryMaxRetries.set(session.settings, 1);
		const waitSpy = mockSchedulerWaitWithClock();
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider !== currentModel.provider || model.id !== currentModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			if (attemptedModels.length === 1) {
				throw new compactionModule.NativeCompactionError(
					new AIError.ProviderHttpError("native compaction temporarily unavailable", 503),
				);
			}
			return {
				summary: "native retry summary",
				shortSummary: "native retry",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
		]);
		expect(waitSpy).toHaveBeenCalledTimes(1);
	});

	it("reports native timeout failure without changing models", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession();
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new compactionModule.NativeCompactionError(new Error("provider stream stall timeout")));
		let errorMessage: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") errorMessage = event.errorMessage;
		});

		await triggerAutoCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1]).toBe(currentModel);
		expect(errorMessage).toContain("provider stream stall timeout");
	});

	it("can use soft compaction on the same model after native authentication fails", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession({ includeSoftFallback: true });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			expect(model).toBe(currentModel);
			if (preparation.settings.remoteEnabled === true) {
				throw new compactionModule.NativeCompactionError(
					new AIError.ProviderHttpError("native compaction authentication failed", 401),
				);
			}
			return {
				summary: "same-model soft summary",
				shortSummary: "same model",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(session.model).toBe(currentModel);
		expect(session.sessionManager.getEntries().findLast(entry => entry.type === "compaction")).toMatchObject({
			summary: "same-model soft summary",
		});
	});

	it.each([
		{ status: 503, type: "auth_unavailable", message: "no auth available for codex" },
		{ status: 401, type: "authentication_error", message: "Invalid authentication credentials" },
	])(
		"reports an actionable credential error for HTTP $status without another model",
		async ({ status, type, message }) => {
			const { currentModel, fallbackModel } = await createSession();
			const originalCompact = compactionModule.compact;
			const fetchMock = vi.fn(async () => Response.json({ error: { type, message } }, { status }));
			const compactSpy = vi
				.spyOn(compactionModule, "compact")
				.mockImplementation(async (preparation, model, apiKey, customInstructions, signal, options) => {
					expect(model).toMatchObject({
						provider: currentModel.provider,
						id: currentModel.id,
						api: currentModel.api,
						baseUrl: currentModel.baseUrl,
						remoteCompaction: currentModel.remoteCompaction,
					});
					if (preparation.settings.remoteEnabled === true) {
						return originalCompact(
							{
								...preparation,
								settings: { ...preparation.settings, remoteStreamingV2Enabled: false },
							},
							model,
							apiKey,
							customInstructions,
							signal,
							{ ...options, fetch: fetchMock },
						);
					}
					throw new AIError.ProviderHttpError("local compaction authentication failed", 401);
				});
			const authSpy = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
				if (model.provider === currentModel.provider) return "stale-codex-token";
				if (model.provider === fallbackModel.provider) return "anthropic-token";
				return undefined;
			});

			const error: unknown = await session.compact().catch((err: unknown) => err);
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw new Error("Expected compaction to reject with an Error");
			expect(error.message).toContain(
				`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
			);
			expect(error.message).not.toContain(type);
			expect(error.message).not.toMatch(/\b(?:401|503)\b/);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(compactSpy).toHaveBeenCalledTimes(2);
			expect(
				authSpy.mock.calls.every(
					([model]) => model.provider === currentModel.provider && model.id === currentModel.id,
				),
			).toBe(true);
			expect(session.model).toBe(currentModel);
		},
	);

	it("normalizes a synthetic missing-credentials failure into a provider-specific hint", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					`Summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=${currentModel.id})`,
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			return undefined;
		});

		const error: unknown = await session.compact().catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("Expected compaction to reject with an Error");
		expect(error.message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		expect(error.message).not.toMatch(/auth_unavailable/i);
	});
});
