import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("/fast targets the current model's service-tier family", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-fast-mode-scope-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(modelId: string): Promise<AgentSession> {
		const model = getBundledModel("openai", modelId);
		if (!model) {
			throw new Error(`Expected bundled test model openai/${modelId} to exist`);
		}
		return createSessionForModel(model);
	}

	async function createSessionForModel(model: Model<Api>): Promise<AgentSession> {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage.keys.setRuntime(model.provider, "token");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.subscribe(() => {});
		return session;
	}

	it("enables priority on the OpenAI family for an OpenAI model", async () => {
		const session = await createSession("gpt-5.2");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("enables priority for a custom OpenAI-compatible relay serving an OpenAI model", async () => {
		const session = await createSessionForModel(
			buildModel({
				id: "o4-mini",
				name: "O4 Mini Relay",
				api: "openai-completions",
				provider: "custom-relay",
				baseUrl: "https://relay.example/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 64_000,
			}),
		);
		expect(session.setFastMode(true)).toBe(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
	});

	it("clears the current model's family when disabled", async () => {
		const session = await createSession("gpt-5.2");
		session.setFastMode(true);
		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("toggle reports the resulting state", async () => {
		const session = await createSession("gpt-5.2");
		expect(session.toggleFastMode()).toBe(true);
		expect(session.serviceTierByFamily.openai).toBe("priority");
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTierByFamily.openai).toBeUndefined();
	});
});
