import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createTestModel } from "./helpers/test-model";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same test/test2 runtime keys and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("test", "test-key");
		sharedAuthStorage.keys.setRuntime("test2", "test-key");
		// The slim catalog ships no bundled models, so the registry resolves the
		// persisted test model strings these tests write/restore against a
		// synthetic openai-completions provider instead.
		await Bun.write(
			path.join(sharedDir.path(), "models.yml"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						models: [
							{
								id: "test-model",
								name: "test-model",
								reasoning: false,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 8_192,
							},
							{
								id: "test-model-2",
								name: "test-model-2",
								reasoning: false,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 8_192,
							},
						],
					},
				},
			}),
		);
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-persistence-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getTestModelOrThrow(id: string): Model<Api> {
		const model = createTestModel({ provider: "test", id: id });
		if (!model) throw new Error(`Expected test model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	async function writeRoleModelSession(
		defaultRoleValue: string,
		smolRoleValue: string,
		lastRole = "smol",
	): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: defaultRoleValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: smolRoleValue,
					role: lastRole,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}
	async function createSession(options?: {
		initialModel?: Model<Api>;
		selectInitialModel?: (availableModels: Model<Api>[]) => Model<Api>;
		modelRoles?: Record<string, string>;
		persist?: boolean;
	}): Promise<{ modelRegistry: ModelRegistry; settings: Settings; session: AgentSession }> {
		const modelRegistry = sharedModelRegistry;
		const model =
			options?.initialModel ??
			options?.selectInitialModel?.(modelRegistry.getAvailable()) ??
			getTestModelOrThrow("test-model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModel(modelRoleValue);
				}
			}
		}
		session = new AgentSession({
			agent,
			sessionManager: options?.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
				: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		return result;
	}
	it("switches the active model without persisting by default", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const nextModel = getTestModelOrThrow("test-model-2");
		const defaultRoleValue = modelValue(defaultModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
		});
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(nextModel);

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModel()).toBe(defaultRoleValue);
		expect(modelChangedCount).toBe(1);

		await created.session.setModel(nextModel);
		expect(modelChangedCount).toBe(1);
	});

	it("persists the default role when explicitly requested", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const nextModel = getTestModelOrThrow("test-model-2");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		await created.session.setModel(nextModel, { persist: true });

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModel()).toBe(modelValue(nextModel));
	});

	it("switches the active model even when the live context is over the target window", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const nextModel = getTestModelOrThrow("test-model-2");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		const targetWindow = nextModel.contextWindow ?? 0;
		expect(targetWindow).toBeGreaterThan(0);

		const result = await created.session.setModel(nextModel, { persist: true });

		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModel()).toBe(modelValue(nextModel));
	});

	it("cycles available models without persisting the default role", async () => {
		const created = await createSession({
			selectInitialModel: availableModels => {
				if (availableModels.length <= 1 || !availableModels[0]) {
					throw new Error("Expected at least two available models");
				}
				return availableModels[0];
			},
		});
		const initialModel = created.session.model;
		if (!initialModel) throw new Error("Expected initial model to be set");
		const defaultRoleValue = modelValue(initialModel);
		created.settings.setModel(defaultRoleValue);

		const result = await created.session.cycleModel();

		if (!result) throw new Error("Expected cycleModel to return a new model");
		expect(modelValue(result.model)).not.toBe(defaultRoleValue);
		const activeModel = created.session.model;
		if (!activeModel) throw new Error("Expected active model after cycleModel");
		expect(modelValue(activeModel)).toBe(modelValue(result.model));
		expect(created.settings.getModel()).toBe(defaultRoleValue);
	});

	it("restores the saved default model when switch-session last role is fallback", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const fallbackModel = getTestModelOrThrow("test-model-2");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);

		const created = await createSession({
			initialModel: fallbackModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when startup last role is fallback", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const fallbackModel = getTestModelOrThrow("test-model-2");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);
		const settings = Settings.isolated();
		settings.setModel(modelValue(fallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores a temporary model when switching sessions", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const temporaryModel = getTestModelOrThrow("test-model-2");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(temporaryModel.id);
	});

	it("restores a temporary model during startup resume", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const temporaryModel = getTestModelOrThrow("test-model-2");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");
		const settings = Settings.isolated();
		settings.setModel(defaultRoleValue);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(temporaryModel.id);
	});

	it("marks an incomplete process-exit transcript aborted during SDK resume without dropping history", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted"));
		const interruptedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "state.txt" } }],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendMessage(interruptedAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "preserved partial result" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected interrupted session file");

		const result = await createStartupResumeSession(sessionFile);
		const messages = result.session.sessionManager.buildSessionContext({ transcript: true }).messages;
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Previous OMP process exited before completing the turn.",
		});
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(part => part.type === "text" && part.text === "preserved partial result"),
			),
		).toBe(true);
		expect(messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(
			1,
		);
	});

	it("marks a first user-message process-exit tail aborted with the selected model", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const settings = Settings.isolated();
		settings.setModel(modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted-user"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(
			result.session.sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
				stopReason: "aborted",
			},
		});
	});

	/** A valid 800x500 RGB PNG of noise deflate cannot shrink: ~1.6 MB of base64, decodable by the send path's image checks. */
	function framePng(seed: number): string {
		const pixels = new Uint32Array((800 * 500 * 3) / 4);
		let state = seed;
		for (let i = 0; i < pixels.length; i++) {
			// xorshift32, so every run encodes the same bytes.
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			pixels[i] = state;
		}
		return encodeRawPng(new Uint8Array(pixels.buffer), 800, 500, 3).toString("base64");
	}

	/** Appends a 4.8 MB three-frame archive: over the 3 MB uniform frame budget, so restore keeps only the first frame. */
	function appendFrameArchive(sessionManager: SessionManager, firstKeptEntryId: string): void {
		const frame = (seed: number) => ({
			data: framePng(seed),
			mimeType: "image/png",
			cols: 8,
			rows: 8,
			chars: 8,
		});
		sessionManager.appendCompaction("Archived history.", "archive", firstKeptEntryId, 150_000, {
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [frame(0x40), frame(0x80), frame(0xc0)],
					totalChars: 24,
					truncatedChars: 0,
				},
			},
		});
	}

	function archiveImages(messages: readonly AgentMessage[]): number {
		const summary = messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected a restored compaction summary");
		return summary.blocks?.filter(block => block.type === "image").length ?? 0;
	}

	/** Resumes a session whose archive was compacted on the official Test API. */
	async function resumeArchivedSession(
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
	): Promise<CreateAgentSessionResult> {
		const defaultModel = getTestModelOrThrow("test-model");
		const settings = Settings.isolated();
		settings.setModel(modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "archived"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		});
		appendFrameArchive(sessionManager, firstKeptEntryId);
		return createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
	}

	it("restores a snapcompact archive at the resumed model's frame payload budget", async () => {
		const result = await resumeArchivedSession(sharedAuthStorage, sharedModelRegistry);
		session = result.session;

		// The slim fork removed per-provider image budgets; frame payloads are now
		// capped at the model-less `snapcompact.DEFAULT_FRAME_DATA_BYTES_BUDGET`
		// (3 MB). The 4.8 MB three-frame archive therefore keeps only its first
		// ~1.6 MB frame.
		expect(archiveImages(result.session.messages)).toBe(1);
	});

	it("marks an interrupted first turn aborted when switching sessions", async () => {
		const defaultModel = getTestModelOrThrow("test-model");
		const created = await createSession({ initialModel: defaultModel, persist: true });
		const targetFile = path.join(tempDir.path(), "switch-interrupted-user.jsonl");
		const timestamp = "2026-07-11T02:20:08.800Z";
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "switch-target", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: modelValue(defaultModel),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "inspect state", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "exit",
					parentId: "user",
					timestamp,
					customType: "session_exit",
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(created.session.switchSession(targetFile)).resolves.toBe(true);

		expect(created.session.sessionManager.buildSessionContext({ transcript: true }).messages.at(-1)).toMatchObject({
			role: "assistant",
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
			stopReason: "aborted",
		});
	});

	it("lists restorable temporary model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "test/test-model",
					temporary: "test/test-model-2",
				},
				"temporary",
			),
		).toEqual(["test/test-model-2", "test/test-model"]);
	});

	it("lists only the default model for ephemeral fallback restores", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "test/test-model",
					[EPHEMERAL_MODEL_CHANGE_ROLE]: "test/test-model-2",
				},
				EPHEMERAL_MODEL_CHANGE_ROLE,
			),
		).toEqual(["test/test-model"]);
	});
});
