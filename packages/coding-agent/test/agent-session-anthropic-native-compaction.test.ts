import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: unknown[];
}

/** One signed-thinking answer, streamed as the Messages API does. */
function answer(turn: number): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `plan ${turn}` } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `answer ${turn}` } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));
}

describe("AgentSession Anthropic native compaction", () => {
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;

	beforeEach(() => {
		// A provider proxy moves first-party requests off the Cowork transport
		// onto `globalThis.fetch`, where the spy below answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
	});

	it("sends the summarized prefix with the live turn's system prompt, tools and message bytes", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-");
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected bundled claude-opus-5-5");
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith("https://api.anthropic.com/v1/messages")) {
					throw new Error(`Unexpected request to ${String(input)}`);
				}
				const body: MessagesRequest = JSON.parse(String(init?.body));
				requests.push(body);
				// Two live turns answer; the compaction request is only captured.
				if (requests.length <= 2) return answer(requests.length);
				return new Response(
					JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.methodOrder": ["remote"], "compaction.keepRecentTokens": 1 }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		expect(requests).toHaveLength(3);
		const [, live, compaction] = requests;
		// The live turn carries the injected intent field and the first-turn
		// date/cwd reminder; the compaction request must carry them too.
		expect(JSON.stringify(live.tools)).toContain('"i"');
		expect(JSON.stringify(live.messages[0])).toContain("<system-reminder>");
		expect(compaction.system).toEqual(live.system);
		expect(compaction.tools).toEqual(live.tools);
		expect(compaction.messages.length).toBeGreaterThan(0);
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
	});
});
