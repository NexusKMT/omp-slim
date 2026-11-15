import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "./helpers/bundled-model";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards the session-managed builtin ACTIVATION wiring in createAgentSession:
// an explicit `toolNames` whitelist would otherwise drop the paired checkpoint
// and rewind tools from the active set, so the SDK must re-activate the
// checkpoint/rewind pair (mirroring the `yield` invariant).
describe("createAgentSession session-managed tool activation", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	function noDiscoveryOptions() {
		return {
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-autolearn-active-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("activates checkpoint and rewind when only rewind is in an explicit toolNames list", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["rewind"],
			requireYieldTool: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});

	it("activates checkpoint and rewind in a restricted session with one-sided toolNames", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...noDiscoveryOptions(),
			toolNames: ["checkpoint"],
			requireYieldTool: true,
			restrictToolNames: true,
		});
		sessions.push(session);
		const names = session.getActiveToolNames();
		expect(names).toContain("checkpoint");
		expect(names).toContain("rewind");
	});
});
