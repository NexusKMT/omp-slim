import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, SessionBusyError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { assistantMsg } from "./utilities";

describe("AgentSession.fork(entryId)", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	/** Resolves once a prompt reaches the model, which then streams for a minute. */
	let providerStarted: PromiseWithResolvers<void>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-at-entry-"));
		providerStarted = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		await removeWithRetries(tempDir);
		vi.restoreAllMocks();
	});

	/** A persisted session seeded with [user, assistant(artifact://<id>), user, assistant]; returns the assistant entry to fork at. */
	async function createSeededSession(extensionRunner?: ExtensionRunner) {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({
				handler: () => {
					providerStarted.resolve();
					return { content: ["slow reply"], delayMs: 60_000 };
				},
			}).stream,
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "sessions")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			extensionRunner,
		});
		const manager = session.sessionManager;
		const artifactId = await manager.saveArtifact("kept tool output", "bash");
		if (artifactId === undefined) throw new Error("Expected a persisted artifact");
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const forkAt = manager.appendMessage(assistantMsg(`Full output: artifact://${artifactId}`));
		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		manager.appendMessage(assistantMsg("second reply"));
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		await manager.flush();
		return { session, artifactId, forkAt };
	}

	it("keeps cited artifacts resolvable and allocates fresh ids after the cut", async () => {
		const { session, artifactId, forkAt } = await createSeededSession();
		const sourceFile = session.sessionFile;

		expect(await session.fork(forkAt)).toBe(true);

		expect(session.sessionFile).not.toBe(sourceFile);
		const keptPath = await session.sessionManager.getArtifactPath(artifactId);
		expect(keptPath).not.toBeNull();
		expect(await Bun.file(keptPath!).text()).toBe("kept tool output");
		const newId = await session.sessionManager.saveArtifact("fork output", "bash");
		expect(newId).not.toBe(artifactId);
		expect(await Bun.file(keptPath!).text()).toBe("kept tool output");
	});

	it("leaves the session file and live messages untouched when session_before_branch vetoes", async () => {
		const emit = vi.fn(async (event: { type: string }) =>
			event.type === "session_before_branch" ? { cancel: true } : undefined,
		);
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_branch",
			emit,
		} as unknown as ExtensionRunner;
		const { session, forkAt } = await createSeededSession(extensionRunner);
		const sourceFile = session.sessionFile!;
		const sourceRaw = await Bun.file(sourceFile).text();
		const sourceMessages = structuredClone(session.messages);

		expect(await session.fork(forkAt)).toBe(false);

		expect(emit).toHaveBeenCalledWith({ type: "session_before_branch", entryId: forkAt });
		expect(session.sessionFile).toBe(sourceFile);
		expect(session.messages).toEqual(sourceMessages);
		expect(await Bun.file(sourceFile).text()).toBe(sourceRaw);
		expect((await fs.readdir(path.dirname(sourceFile))).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(sourceFile),
		]);
	});

	it("refuses while a turn is streaming and keeps the session in place", async () => {
		const { session, forkAt } = await createSeededSession();
		const sourceFile = session.sessionFile;
		const turn = session.prompt("third");
		await providerStarted.promise;

		await expect(session.fork(forkAt)).rejects.toBeInstanceOf(SessionBusyError);
		expect(session.sessionFile).toBe(sourceFile);

		await session.abort({ goalReason: "internal", reason: "test cleanup" });
		await turn;
	});

	it("refuses when user work starts while session_before_branch awaits", async () => {
		// The hook admits user eval work, which keeps running after the hook returns.
		const userEval = new AbortController();
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_branch",
			emit: async () => {
				session!.trackEvalExecution(Promise.withResolvers<void>().promise, userEval).catch(() => undefined);
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const { session: seeded, forkAt } = await createSeededSession(extensionRunner);
		const sourceFile = seeded.sessionFile!;
		expect(seeded.isBusyForSnapshot).toBe(false);

		await expect(seeded.fork(forkAt)).rejects.toBeInstanceOf(SessionBusyError);

		expect(seeded.sessionFile).toBe(sourceFile);
		expect((await fs.readdir(path.dirname(sourceFile))).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(sourceFile),
		]);
		userEval.abort();
	});

	it("refuses when user work starts while the pre-cut flush awaits", async () => {
		const { session: seeded, forkAt } = await createSeededSession();
		const sourceFile = seeded.sessionFile!;
		const userEval = new AbortController();
		const flush = seeded.sessionManager.flush.bind(seeded.sessionManager);
		vi.spyOn(seeded.sessionManager, "flush").mockImplementation(async () => {
			seeded.trackEvalExecution(Promise.withResolvers<void>().promise, userEval).catch(() => undefined);
			await flush();
		});
		expect(seeded.isBusyForSnapshot).toBe(false);

		await expect(seeded.fork(forkAt)).rejects.toBeInstanceOf(SessionBusyError);

		expect(seeded.sessionFile).toBe(sourceFile);
		expect((await fs.readdir(path.dirname(sourceFile))).filter(name => name.endsWith(".jsonl"))).toEqual([
			path.basename(sourceFile),
		]);
		userEval.abort();
	});
});
