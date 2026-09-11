import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression guard for #11555: RPC queue-mode setters must configure only the
 * calling session by default, never write the machine-global `config.yml`.
 */
describe("AgentSession queue-mode controls are session-scoped by default", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let configPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queue-scope-");
		const agentDir = tempDir.path();
		configPath = path.join(agentDir, "config.yml");

		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});
	});

	afterEach(async () => {
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("applies queue-mode changes in-session without persisting to global config.yml", async () => {
		session.setSteeringMode("one-at-a-time");
		session.setFollowUpMode("one-at-a-time");
		session.setInterruptMode("wait");
		await settings.flush();

		expect(settings.get("steeringMode")).toBe("one-at-a-time");
		expect(settings.get("followUpMode")).toBe("one-at-a-time");
		expect(settings.get("interruptMode")).toBe("wait");
		expect(settings.getGlobalSettings()).toEqual({});
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	it("persists to global config.yml when persist=true (settings panel path)", async () => {
		session.setSteeringMode("one-at-a-time", true);
		session.setFollowUpMode("one-at-a-time", true);
		session.setInterruptMode("wait", true);
		await settings.flush();

		expect(settings.getGlobalSettings()).toMatchObject({
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
		});
		const onDisk = await Bun.file(configPath).text();
		expect(onDisk).toContain("steeringMode: one-at-a-time");
		expect(onDisk).toContain("followUpMode: one-at-a-time");
		expect(onDisk).toContain("interruptMode: wait");
	});
});
