import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getTestModel as getBundledModel } from "../../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRetryEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";

/**
 * Regression guard for #11431: `set_auto_compaction`/`set_auto_retry` (which drive
 * `AgentSession.setAutoCompactionEnabled`/`setAutoRetryEnabled`) must configure only
 * the calling session by default, never write the machine-global `config.yml`. The
 * explicit `persist` flag — used by the TUI settings panel — is the only path that
 * mutates durable global state.
 *
 * The provider cache-warming half of the original suite was removed with the
 * provider transports; only the auto-maintenance scoping contract is retained.
 */
describe("AgentSession auto-maintenance controls scope", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let configPath: string;
	let model: Model;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-scope-");
		const agentDir = tempDir.path();
		configPath = path.join(agentDir, "config.yml");

		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: Settings.isolated() });

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled claude-sonnet-4-5 model");
		model = bundled;
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("applies the change in-session without persisting to global config.yml", async () => {
		session.setAutoCompactionEnabled(false);
		session.setAutoRetryEnabled(false);
		await settings.flush();

		// Value is live for this session.
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(cfgRetryEnabled.get(settings)).toBe(false);

		// ...but it never touched the persisted global layer or disk.
		expect(settings.getGlobalSettings()).toEqual({});
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	it("persists to global config.yml when persist=true (settings panel path)", async () => {
		session.setAutoCompactionEnabled(false);
		session.setAutoRetryEnabled(false);
		session.setAutoCompactionEnabled(true, true);
		session.setAutoRetryEnabled(true, true);
		await settings.flush();

		expect(cfgCompactionEnabled.get(settings)).toBe(true);
		expect(cfgRetryEnabled.get(settings)).toBe(true);
		expect(settings.getGlobalSettings()).toMatchObject({
			compaction: { enabled: true },
			retry: { enabled: true },
		});
		const onDisk = await Bun.file(configPath).text();
		expect(onDisk).toContain("enabled: true");
	});
});
