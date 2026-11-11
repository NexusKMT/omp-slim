import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

/** Build the standard Chat tool choice for an explicitly named tool. */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	return model?.api === "openai-completions" ? { type: "function", name: toolName } : undefined;
}

/**
 * Whether the given tool choice can be satisfied by the active tool set for the
 * upcoming turn. Non-named choices (`"none"`, `"required"`, etc.) do not name a
 * specific tool and are therefore always active.
 */
export function isToolChoiceActive(toolChoice: ToolChoice | undefined, tools: readonly { name: string }[]): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}
