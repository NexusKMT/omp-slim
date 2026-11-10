import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { MODEL_MENTION_ENTRY_TYPE, readModelMentions } from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let auth: AuthStorage;
let registry: ModelRegistry;
let session: SessionManager;

beforeEach(async () => {
	auth = await AuthStorage.create(":memory:");
	registry = new ModelRegistry(auth, "/nonexistent/model-mentions/models.yml");
	session = SessionManager.inMemory();
});

afterEach(() => {
	vi.restoreAllMocks();
	auth.close();
});

function createSession(): AgentSession {
	const current = createMockModel({ id: "current", responses: [{ content: ["Done"] }] });
	const other = createMockModel({ id: "other" });
	vi.spyOn(registry, "getAvailable").mockReturnValue([current, other]);
	vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: current, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: current.stream,
	});
	return new AgentSession({
		agent,
		sessionManager: session,
		modelRegistry: registry,
		settings: Settings.isolated({ "compaction.enabled": false }),
	});
}

describe("retired model mentions", () => {
	test("sends a caret model selector as literal user text without creating another agent", async () => {
		const agentSession = createSession();
		const current = agentSession.model;
		try {
			await agentSession.prompt("ask ^mock/other to help");
			expect(agentSession.model).toBe(current);
			expect(agentSession.getSessionAgents()).toEqual([]);
			expect(readModelMentions(session.getBranch())).toEqual([]);
			const submitted = agentSession.agent.state.messages.find(message => message.role === "user");
			expect(submitted?.content).toEqual([{ type: "text", text: "ask ^mock/other to help" }]);
			expect(
				agentSession.agent.state.messages.some(
					message => message.role === "custom" && message.customType === "session-agent-notice",
				),
			).toBe(false);
		} finally {
			await agentSession.dispose();
		}
	});

	test("preserves literal skill arguments and image queue content without a model-agent notice", async () => {
		const agentSession = createSession();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-literal-model-mention-"));
		const filePath = path.join(directory, "SKILL.md");
		await Bun.write(filePath, "Skill body: ^mock/other");
		const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
		try {
			const built = await agentSession.buildUserSkillPrompt(
				{ name: "test", filePath, baseDir: directory },
				{ args: "ask ^mock/other to help" },
			);
			agentSession.agent.state.isStreaming = true;
			await agentSession.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: [{ type: "text", text: built.message }, image],
					display: true,
					details: built.details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueOnly: true },
			);
			const queued = agentSession.agent.peekSteeringQueue();
			const skill = queued.find(
				(message): message is CustomMessage =>
					message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
			);
			expect(skill?.content).toEqual([{ type: "text", text: built.message }, image]);
			expect(built.message).toContain("User: ask ^mock/other to help");
			expect(built.message).toContain("Skill body: ^mock/other");
			expect(readModelMentions(session.getBranch())).toEqual([]);
			expect(agentSession.getSessionAgents()).toEqual([]);
			expect(
				queued.some(message => message.role === "custom" && message.customType === "session-agent-notice"),
			).toBe(false);
		} finally {
			agentSession.agent.state.isStreaming = false;
			await agentSession.dispose();
			await removeWithRetries(directory);
		}
	});

	test("removes queued literal selectors using the text submitted by the client", async () => {
		const agentSession = createSession();
		try {
			agentSession.agent.state.isStreaming = true;
			const raw = "ask ^mock/other to help";
			expect(await agentSession.prompt(raw, { streamingBehavior: "steer" })).toBe(true);
			expect(agentSession.getQueuedMessages().steering).toEqual([raw]);
			expect(agentSession.removeQueuedMessage(raw, "steering")).toBe(true);
			expect(agentSession.getQueuedMessages().steering).toEqual([]);
			expect(readModelMentions(session.getBranch())).toEqual([]);
		} finally {
			agentSession.agent.state.isStreaming = false;
			await agentSession.dispose();
		}
	});

	test("reads canonical historical effort tags and ignores invalid effort records", () => {
		for (const data of [
			{ agent: "m1", selector: "p/model:high", name: "Historical high", thinkingLevel: "high" },
			{ agent: "m2", selector: "p/model:low", name: "Noncanonical", thinkingLevel: "lo" },
			{ agent: "m3", selector: "p/model:max", name: "Mismatched", thinkingLevel: "high" },
		])
			session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, data);
		expect(readModelMentions(session.getBranch())).toEqual([
			{ agent: "m1", selector: "p/model:high", name: "Historical high", thinkingLevel: "high" },
		]);
	});

	test("keeps the first valid historical record on the current branch without creating live agents", async () => {
		const first = session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, {
			agent: "m1",
			selector: "mock/other",
			name: "Other",
		});
		for (const data of [
			null,
			{ agent: "wrong", selector: "b/y", name: "Invalid agent" },
			{ agent: "m9", selector: 3, name: "Invalid selector" },
			{ agent: "m1", selector: "c/w", name: "Duplicate agent" },
			{ agent: "m8", selector: "mock/other", name: "Duplicate selector" },
			{ agent: "m2", selector: "b/y", name: "Y" },
		])
			session.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, data);
		expect(readModelMentions(session.getBranch()).map(mention => mention.agent)).toEqual(["m1", "m2"]);
		session.branch(first);
		const agentSession = createSession();
		try {
			expect(agentSession.modelMentions).toEqual([{ agent: "m1", selector: "mock/other", name: "Other" }]);
			expect(agentSession.getSessionAgents()).toEqual([]);
		} finally {
			await agentSession.dispose();
		}
	});
});
