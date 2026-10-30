import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resetConnectionPrewarmForTesting } from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { resetDispatchOriginsForTesting } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

// What a provider surfaces when the request never connected: the Anthropic
// client's rewrite of a `getaddrinfo ENOTFOUND` rejection, as seen offline.
const CONNECT_FAILURE =
	"Couldn't reach api.anthropic.com (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.";
const LOCAL_ORIGIN = "http://127.0.0.1:11434";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type FallbackApplied = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;

describe("AgentSession fallback chain when the request never connected", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const cloudFallback = getBundledModel("openai", "gpt-4o-mini");
	if (!primary || !cloudFallback) throw new Error("Expected bundled test models to exist");

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
				`    baseUrl: ${LOCAL_ORIGIN}/v1`,
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

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
		resetConnectionPrewarmForTesting();
		resetDispatchOriginsForTesting();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	/** Answers the probe for hosts in `reachable`; every other host rejects the way an offline machine does. */
	function stubNetwork(reachable: readonly string[]): string[] {
		const probed: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = input instanceof Request ? input.url : String(input);
				probed.push(url);
				if (reachable.includes(new URL(url).origin)) return new Response(null, { status: 404 });
				throw Object.assign(new TypeError("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
			}),
		);
		return probed;
	}

	/** Runs one prompt whose first request on the primary fails with `firstError`; every later request answers. */
	async function runTurn(
		firstError: string,
		chain: string[],
	): Promise<{ requested: string[]; retryStarts: RetryStart[]; applied: FallbackApplied[] }> {
		const requested: string[] = [];
		const mock = createMockModel();
		let failed = false;
		const agent = new Agent({
			getApiKey: (model: Model) => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				const response: MockResponse = failed ? { content: ["ok"] } : { throw: firstError };
				failed = true;
				mock.push(response);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: chain },
		});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const retryStarts: RetryStart[] = [];
		const applied: FallbackApplied[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "retry_fallback_applied") applied.push(event);
		});
		await session.prompt("say ok");
		await session.waitForIdle();
		return { requested, retryStarts, applied };
	}

	it("stays on the primary and reports offline when the fallback's host does not answer either", async () => {
		// Regression: offline, the chain switched to a fallback that failed the same way.
		const probed = stubNetwork([]);

		const { requested, retryStarts, applied } = await runTurn(CONNECT_FAILURE, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual(["https://api.openai.com"]);
		expect(applied).toEqual([]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"]);
		expect(retryStarts.map(event => event.offline)).toEqual([true]);
	});

	it("switches to the fallback when its host answers: only the primary's provider is down", async () => {
		const probed = stubNetwork(["https://api.openai.com"]);

		const { requested, retryStarts, applied } = await runTurn(CONNECT_FAILURE, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual(["https://api.openai.com"]);
		expect(applied.map(event => event.to)).toEqual(["openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"]);
		expect(retryStarts.map(event => event.offline)).toEqual([undefined]);
	});

	it("switches to a local fallback offline, skipping the cloud entry whose host does not answer", async () => {
		const probed = stubNetwork([LOCAL_ORIGIN]);

		const { requested, retryStarts, applied } = await runTurn(CONNECT_FAILURE, [
			"openai/gpt-4o-mini",
			"local-llm/local-model",
		]);

		expect(probed).toEqual(["https://api.openai.com", LOCAL_ORIGIN]);
		expect(applied.map(event => event.to)).toEqual(["local-llm/local-model"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "local-llm/local-model"]);
		expect(retryStarts.map(event => event.offline)).toEqual([undefined]);
	});

	it.each([
		["a rate limit", "429 rate limit exceeded"],
		["a server error", "overloaded_error: provider returned error 503"],
	])("walks the chain for %s without probing, as before", async (_label, error) => {
		// Every host rejects: a probe here would skip the fallback.
		const probed = stubNetwork([]);

		const { requested, retryStarts, applied } = await runTurn(error, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual([]);
		expect(applied.map(event => event.to)).toEqual(["openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"]);
		expect(retryStarts.map(event => event.offline)).toEqual([undefined]);
	});
});
