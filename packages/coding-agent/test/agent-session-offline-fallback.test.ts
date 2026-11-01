import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** `networkFailureMessage`'s rewrite of a rejected fetch to `host`: no server answered. */
const unreachable = (host: string) =>
	`Couldn't reach ${host} (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.`;
const ANTHROPIC_DOWN = unreachable("api.anthropic.com");
const OPENAI_DOWN = unreachable("api.openai.com");
const SERVER_ERROR = "overloaded_error: provider returned error 503";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!primary) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");

describe("AgentSession fallback chain on connect failures", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-offline-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  local-llm:",
				"    baseUrl: http://127.0.0.1:11434/v1",
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: local-model",
				"",
			].join("\n"),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		modelRegistry.clearSuppressedSelectors();
	});

	/** Runs one prompt whose first requests fail with `errors`, in order; later requests answer. */
	async function run(
		errors: string[],
		chain = ["openai/gpt-4o-mini", "openai/gpt-4o"],
	): Promise<{ requested: string[]; switchedTo: string[] }> {
		const requested: string[] = [];
		const switchedTo: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: (model: Model) => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				const error = errors[requested.length];
				requested.push(`${model.provider}/${model.id}`);
				const response: MockResponse = error === undefined ? { content: ["ok"] } : { throw: error };
				mock.push(response);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: chain },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") switchedTo.push(event.to);
		});
		await session.prompt("say ok");
		await session.waitForIdle();
		return { requested, switchedTo };
	}

	it("stays on the current model once a second host fails to connect and no local model is configured", async () => {
		// Regression: offline, every chain entry was tried in turn and each failed the same way.
		const { requested, switchedTo } = await run([ANTHROPIC_DOWN, OPENAI_DOWN]);

		expect(switchedTo).toEqual(["openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini", "openai/gpt-4o-mini"]);
	});

	it("jumps past the remaining cloud entries to a local model once the network looks down", async () => {
		const { requested, switchedTo } = await run(
			[ANTHROPIC_DOWN, OPENAI_DOWN],
			["openai/gpt-4o-mini", "openai/gpt-4o", "local-llm/local-model"],
		);

		expect(switchedTo).toEqual(["openai/gpt-4o-mini", "local-llm/local-model"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini", "local-llm/local-model"]);
	});

	it("counts a first-party model rerouted to a local gateway as local", async () => {
		// `ANTHROPIC_BASE_URL` sends a stock Anthropic model to this machine; its catalog URL stays remote.
		const previous = Bun.env.ANTHROPIC_BASE_URL;
		Bun.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
		try {
			const { switchedTo } = await run(
				[ANTHROPIC_DOWN, OPENAI_DOWN],
				["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-haiku-4-5"],
			);
			expect(switchedTo).toEqual(["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"]);
		} finally {
			if (previous === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
			else Bun.env.ANTHROPIC_BASE_URL = previous;
		}
	});

	it("keeps walking when every failed request went to one host", async () => {
		// One provider's host is down, not the network: the next chain entry may live elsewhere.
		const { requested, switchedTo } = await run([OPENAI_DOWN, OPENAI_DOWN]);

		expect(switchedTo).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini", "openai/gpt-4o"]);
	});

	it("does not count a stopped local server as evidence the network is down", async () => {
		const localRefused =
			"Couldn't connect to 127.0.0.1:11434 (connection refused). Check that the server is running and reachable.";
		const { requested, switchedTo } = await run(
			[ANTHROPIC_DOWN, localRefused],
			["local-llm/local-model", "openai/gpt-4o-mini"],
		);

		expect(switchedTo).toEqual(["local-llm/local-model", "openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "local-llm/local-model", "openai/gpt-4o-mini"]);
	});

	it("keeps walking when the fallback reached a server", async () => {
		const { requested, switchedTo } = await run([ANTHROPIC_DOWN, SERVER_ERROR]);

		expect(switchedTo).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini", "openai/gpt-4o"]);
	});

	it("resumes walking the chain once a later attempt reaches a server", async () => {
		// The network came back: a 503 on the held model must not keep cloud fallbacks skipped.
		const { requested, switchedTo } = await run([ANTHROPIC_DOWN, OPENAI_DOWN, SERVER_ERROR]);

		expect(switchedTo).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o"]);
		expect(requested).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-4o-mini",
			"openai/gpt-4o-mini",
			"openai/gpt-4o",
		]);
	});
});
