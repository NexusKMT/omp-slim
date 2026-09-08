import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

async function expectProviderYieldContract(
	session: AgentSession,
	dialect: "native" | "gemini",
	pooled: boolean,
): Promise<void> {
	const providerContext = await session.agent.buildSideRequestContext([]);
	if (dialect === "native") {
		const providerTool = providerContext.tools?.find(candidate => candidate.name === "yield");
		if (!providerTool) throw new Error("Missing provider yield tool");
		const properties = Reflect.get(providerTool.parameters, "properties");
		if (pooled) {
			expect(Reflect.get(providerTool.parameters, "required")).toEqual(["key"]);
			expect(properties).toHaveProperty("key");
			expect(properties).not.toHaveProperty("type");
		} else {
			expect(properties).toHaveProperty("type");
			expect(properties).not.toHaveProperty("key");
		}
		return;
	}

	const providerSystemPrompt = providerContext.systemPrompt;
	if (!providerSystemPrompt) throw new Error("Missing provider system prompt");
	const providerPrompt = providerSystemPrompt.join("\n");
	expect(providerPrompt.match(/type yield =/g)).toHaveLength(1);
	const yieldStart = providerPrompt.indexOf("type yield =");
	const nextType = providerPrompt.indexOf("\ntype ", yieldStart + 1);
	const namespaceEnd = providerPrompt.indexOf("\n\n} // namespace functions", yieldStart + 1);
	let yieldEnd = nextType;
	if (yieldEnd < 0 || (namespaceEnd >= 0 && namespaceEnd < yieldEnd)) yieldEnd = namespaceEnd;
	if (yieldEnd < 0) throw new Error("Missing provider yield declaration boundary");
	const yieldDeclaration = providerPrompt.slice(yieldStart, yieldEnd);
	if (pooled) {
		expect(yieldDeclaration).toContain("key: 1,");
		expect(yieldDeclaration).not.toContain("type?:");
	} else {
		expect(yieldDeclaration).toContain("type?:");
		expect(yieldDeclaration).not.toContain("key:");
	}
}

describe("SDK workpool yield schema", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-workpool-yield-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	for (const [dialect, toolSettings] of [
		["native", {}],
		["gemini", { "tools.format": "gemini" }],
	] as const) {
		it("keeps the provider yield contract synchronized through a pooled turn (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				requireYieldTool: true,
				toolNames: ["yield"],
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-worker",
				agentId: "workpool-worker",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			const tool = session.getToolByName("yield");
			if (!tool) throw new Error("Missing yield tool");
			expect(Reflect.get(tool.parameters, "properties")).toHaveProperty("type");
			expect(Reflect.get(tool.parameters, "properties")).not.toHaveProperty("key");
			await expectProviderYieldContract(session, dialect, false);

			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			expect(Reflect.get(tool.parameters, "required")).toEqual(["key"]);
			const properties = Reflect.get(tool.parameters, "properties");
			expect(properties).toHaveProperty("key");
			expect(properties).not.toHaveProperty("type");
			const activeTool = session.agent.state.tools.find(candidate => candidate.name === "yield");
			if (!activeTool) throw new Error("Missing active yield tool");
			expect(Reflect.get(activeTool.parameters, "required")).toEqual(["key"]);
			await expectProviderYieldContract(session, dialect, true);
			const result = await tool.execute("yield-pool-1", { key: 1, data: { answer: 42 } });
			expect(result.details).toMatchObject({ type: ["pool#1"], complete: true });

			await session.setWorkPoolYieldItems([]);
			const clearedProperties = Reflect.get(tool.parameters, "properties");
			expect(clearedProperties).toHaveProperty("type");
			expect(clearedProperties).not.toHaveProperty("key");
			await expectProviderYieldContract(session, dialect, false);
		});
	}
});
