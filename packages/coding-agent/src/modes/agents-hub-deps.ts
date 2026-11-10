import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { EffectiveExtensionRoots } from "../capability/types";
import { getConfigDirs } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import agentCreationArchitectPrompt from "../prompts/system/agent-creation-architect.md" with { type: "text" };
import agentCreationUserPrompt from "../prompts/system/agent-creation-user.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import { refreshAgentDiscovery } from "../task";
import { discoverAgents } from "../task/discovery";

import { cfgTaskAgentAdvisor, cfgTaskDisabledAgents } from "../task/settings";

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || block.type !== "text" || !("text" in block)) return "";
				const value = block.text;
				return typeof value === "string" ? value : "";
			})
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}

export function createAgentsHubDeps(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	extensionRoots: () => EffectiveExtensionRoots,
	activeModel?: Model,
	thinkingLevel?: ConfiguredThinkingLevel,
): AgentsHubDeps {
	return {
		loadAgents: async () => {
			const { agents } = await discoverAgents(cwd, undefined, extensionRoots());
			const disabled = new Set(cfgTaskDisabledAgents.get(settings));
			const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
			return agents.map(agent => ({
				...agent,
				disabled: disabled.has(agent.name),
				advisor:
					advisorOverrides[agent.name] === "on" ||
					(advisorOverrides[agent.name] !== "off" && agent.advisor === true),
			}));
		},
		setAgentDisabled: (name, { disabled }) => cfgTaskDisabledAgents.setMember(settings, name, { member: disabled }),
		setAgentAdvisor: (name, enabled) => cfgTaskAgentAdvisor.setEntry(settings, name, enabled ? "on" : "off"),
		generateAgent: async (description, onText) => {
			const selectedModel = activeModel;
			if (!selectedModel) throw new Error("Select a current model before creating an agent.");
			const { session } = await createAgentSession({
				cwd,
				authStorage: modelRegistry.authStorage,
				modelRegistry,
				settings,
				model: selectedModel,
				thinkingLevel,
				systemPrompt: [prompt.render(agentCreationArchitectPrompt, {})],
				hasUI: false,
				enableLsp: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				toolNames: ["__none__"],
				customTools: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				// A helper for the host session: the host keeps the process-wide effects and provider toggles.
				bindProcessState: false,
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_update" && "assistantMessageEvent" in event) {
					const ame = event.assistantMessageEvent;
					if (ame.type === "text_delta") onText(ame.delta);
				}
			});
			try {
				await session.prompt(prompt.render(agentCreationUserPrompt, { request: description }), {
					expandPromptTemplates: false,
				});
				const raw = extractAssistantText(session.state.messages);
				if (!raw) throw new Error("No response returned by agent creation architect.");
				return raw;
			} finally {
				unsubscribe();
				await session.dispose();
			}
		},
		saveAgent: async (scope, spec) => {
			const dirs = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd });
			const targetDir = dirs[0]?.path;
			if (!targetDir) throw new Error(`Cannot resolve ${scope} agents directory.`);
			const filePath = path.join(targetDir, `${spec.identifier}.md`);
			try {
				await fs.stat(filePath);
				throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const frontmatter = YAML.stringify({ name: spec.identifier, description: spec.whenToUse }, null, 2).trimEnd();
			await Bun.write(filePath, `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`);
			await refreshAgentDiscovery(cwd, extensionRoots());
			return filePath;
		},
	};
}
