/**
 * A snapcompact compaction's persisted `tokensAfter` (the transcript divider
 * and RPC figure) must equal what the compaction trigger counts for the
 * committed context. The projection used to run the rebuilt context through
 * `convertToLlm`, which turns the compaction summary into a plain user message
 * whose frames get the generic image estimate; the trigger counts the summary
 * itself at the active model's frame price. On Gemini (2048px frames billed a
 * flat 1,120) that put `tokensAfter` ~3.8k per frame above the live count.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as snapcompact from "@oh-my-pi/snapcompact";

describe("snapcompact tokensAfter matches the post-commit context count", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	afterAll(() => {
		authStorage.close();
	});

	function bundled(provider: "google" | "openai-codex", id: string): Model {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
		return { ...model, contextWindow: 400_000, maxTokens: 32_000 };
	}

	/** A session with enough discarded history for a multi-frame archive. */
	function createSession(model: Model): AgentSession {
		const sessionManager = SessionManager.inMemory();
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		const turns = 120;
		for (let i = 0; i < turns; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: Date.now() - (turns - i) * 1000,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}: ${filler}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 1000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - (turns - i) * 1000 + 100,
			});
		}
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["snapcompact"],
				"compaction.autoContinue": false,
				"compaction.keepRecentTokens": 4000,
			}),
			modelRegistry,
		});
		sessions.push(session);
		return session;
	}

	/** What the compaction trigger counts for the session's current context. */
	function storedContextTokens(session: AgentSession): number {
		return (
			computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision) +
			session.agent.tokenizer.countMessages(session.messages, { excludeEncryptedReasoning: true })
		);
	}

	const cases = [
		{ name: "Gemini", provider: "google", id: "gemini-3.1-pro-preview", frameSize: 2048, frameTokens: 1120 },
		{ name: "Codex", provider: "openai-codex", id: "gpt-6.1-sol", frameSize: 1568, frameTokens: 2882 },
	] as const;
	for (const { name, provider, id, frameSize, frameTokens } of cases) {
		it(`persists the trigger's count for a real ${name} archive`, async () => {
			const model = bundled(provider, id);
			expect(snapcompact.resolveShape(model).frameSize).toBe(frameSize);
			const session = createSession(model);

			await session.compact(undefined, { mode: "snapcompact" });

			const entry = session.sessionManager.getBranch().findLast(e => e.type === "compaction");
			if (entry?.type !== "compaction") throw new Error("Expected a committed compaction entry");
			const frames = snapcompact.getPreservedArchive(entry.preserveData)?.frames ?? [];
			expect(frames.length).toBeGreaterThan(1);
			// The committed archive is priced at the model's own frame rate.
			const summary = session.messages.find(m => m.role === "compactionSummary");
			if (summary?.role !== "compactionSummary") throw new Error("Expected a compaction summary message");
			const blocks = summary.blocks ?? [];
			expect(blocks.filter(block => block.type === "image")).toHaveLength(frames.length);
			const tokenizer = session.agent.tokenizer;
			const textOnly = { ...summary, blocks: blocks.filter(block => block.type === "text") };
			expect(tokenizer.countMessage(summary) - tokenizer.countMessage(textOnly)).toBe(frames.length * frameTokens);
			expect(entry.tokensAfter).toBe(storedContextTokens(session));
		});
	}
});
