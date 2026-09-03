import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

async function setup(): Promise<void> {
	sharedDir = TempDir.createSync("@pi-new-session-boundary-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
}

async function teardown(): Promise<void> {
	authStorage.close();
	sharedDir.removeSync();
}

async function createHarness(): Promise<{ agent: Agent; session: AgentSession; sessionManager: SessionManager }> {
	const tempDir = TempDir.createSync("@pi-new-session-boundary-");
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const agent = new Agent({
		initialState: {
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { agent, session, sessionManager };
}

describe("AgentSession.newSession boundary", () => {
	beforeAll(setup);
	afterAll(teardown);
	afterEach(async () => {
		while (cleanup.length > 0) {
			const run = cleanup.pop();
			if (run) await run();
		}
	});

	it("invalidates a primed append-only context so pre-/new bytes never reach the next turn", async () => {
		const { agent, session } = await createHarness();
		const appendOnlyContext = new AppendOnlyContextManager();
		agent.setAppendOnlyContext(appendOnlyContext);
		appendOnlyContext.syncMessages([
			{ role: "user", content: "previous conversation" },
			{ role: "assistant", content: "previous answer" },
		]);
		appendOnlyContext.build({ systemPrompt: ["Test"], messages: [], tools: [] }, { intentTracing: false });
		expect(appendOnlyContext.log.length).toBeGreaterThan(0);
		expect(appendOnlyContext.prefix.built).toBe(true);

		expect(await session.newSession()).toBe(true);

		expect(appendOnlyContext.log.length).toBe(0);
		expect(appendOnlyContext.prefix.built).toBe(false);
	});

	it("tracks provider routing identity to the new local session, not the previous conversation", async () => {
		const { session, sessionManager } = await createHarness();
		const previousSessionId = session.sessionId;

		expect(await session.newSession()).toBe(true);

		expect(session.sessionId).not.toBe(previousSessionId);
		expect(session.sessionId).toBe(sessionManager.getSessionId());
	});
});
