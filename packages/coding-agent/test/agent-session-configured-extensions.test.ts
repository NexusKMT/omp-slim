/**
 * Regression (#9769 review): `AgentSession.configuredExtensionPaths` must retain
 * the SDK's explicit `additionalExtensionPaths` for post-startup reloads. Those
 * roots live only in the construction-time invocation scope, so a getter that
 * returned just `settings.extensions` dropped them from `refreshSkills`,
 * `/reload-plugins`, and MCP rediscovery, silently removing the explicitly
 * supplied packages' skills, commands, agents, and servers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface SessionInputs {
	additionalExtensionPaths?: readonly string[];
	disableExtensionDiscovery?: boolean;
	extensions?: string[];
}

describe("AgentSession.configuredExtensionPaths", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makeSession(inputs: SessionInputs): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ extensions: inputs.extensions ?? [] }),
			modelRegistry: new ModelRegistry(authStorage),
			additionalExtensionPaths: inputs.additionalExtensionPaths,
			disableExtensionDiscovery: inputs.disableExtensionDiscovery,
		});
		sessions.push(session);
		return session;
	}

	it("keeps explicit SDK roots when the extensions setting is empty", async () => {
		const session = await makeSession({ additionalExtensionPaths: ["/ext/explicit"] });
		expect(session.configuredExtensionPaths).toEqual(["/ext/explicit"]);
	});

	it("merges explicit roots ahead of the configured extensions setting", async () => {
		const session = await makeSession({
			additionalExtensionPaths: ["/ext/explicit"],
			extensions: ["/ext/configured"],
		});
		expect(session.configuredExtensionPaths).toEqual(["/ext/explicit", "/ext/configured"]);
	});

	it("exposes only explicit roots when discovery is disabled", async () => {
		const session = await makeSession({
			additionalExtensionPaths: ["/ext/explicit"],
			extensions: ["/ext/configured"],
			disableExtensionDiscovery: true,
		});
		expect(session.configuredExtensionPaths).toEqual(["/ext/explicit"]);
	});
});
