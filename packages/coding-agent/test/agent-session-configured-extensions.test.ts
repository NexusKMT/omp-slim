/**
 * Regression (#9769 review): `AgentSession.effectiveExtensionRoots` must thread
 * the SDK's explicit `additionalExtensionPaths`, the discovery mode, and the
 * live configured `extensions` as three separate lanes for post-startup
 * reloads. Flattening them dropped explicit roots and the `explicit-only` mode
 * from `refreshSkills`, `/reload-plugins`, and MCP rediscovery.
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

describe("AgentSession.effectiveExtensionRoots", () => {
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

	it("keeps explicit SDK roots and merge mode when the extensions setting is empty", async () => {
		const session = await makeSession({ additionalExtensionPaths: ["/ext/explicit"] });
		expect(session.effectiveExtensionRoots).toEqual({
			explicit: ["/ext/explicit"],
			mode: "merge",
			configured: [],
			configuredLevel: "user",
		});
	});

	it("keeps explicit and configured in separate lanes under merge mode", async () => {
		const session = await makeSession({
			additionalExtensionPaths: ["/ext/explicit"],
			extensions: ["/ext/configured"],
		});
		expect(session.effectiveExtensionRoots).toEqual({
			explicit: ["/ext/explicit"],
			mode: "merge",
			configured: ["/ext/configured"],
			configuredLevel: "user",
		});
	});

	it("reports explicit-only mode when discovery is disabled", async () => {
		const session = await makeSession({
			additionalExtensionPaths: ["/ext/explicit"],
			extensions: ["/ext/configured"],
			disableExtensionDiscovery: true,
		});
		expect(session.effectiveExtensionRoots).toMatchObject({ explicit: ["/ext/explicit"], mode: "explicit-only" });
	});
});
