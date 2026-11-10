import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getTestModel as getBundledModel } from "../../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { waitForFile } from "../helpers/skill-image";

// Real RPC dispatch with a `/skill:look` command on a text-only main model.
// The image is saved locally; the first current-model request creates `model-started`
// in the cwd and holds until the test creates `model-release` there.
const cwd = process.cwd();
const skillPath = path.join(cwd, "look", "SKILL.md");
await Bun.write(skillPath, "---\nname: look\ndescription: Look at an image\n---\n\nDescribe the attached image.\n");

const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("zai", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({
	responses: [
		async () => {
			await Bun.write(path.join(cwd, "model-started"), "");
			await waitForFile(path.join(cwd, "model-release"));
			return { content: ["ok"] };
		},
	],
	handler: { content: ["ok"] },
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("zai", "glm-5.3"), systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(cwd),
	settings: Settings.isolated({
		"compaction.enabled": false,
		model: "zai/glm-5.3",
	}),
	modelRegistry,
	toolRegistry: new Map(),
	skills: [
		{
			name: "look",
			description: "Look at an image",
			filePath: skillPath,
			baseDir: path.dirname(skillPath),
			source: "project",
		},
	],
	skillsSettings: { enableSkillCommands: true },
});
await runRpcMode(session);
