/**
 * Wraps CustomTool instances into AgentTool for use with the agent.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../modes/interactive/theme/theme";
import type { CustomTool, CustomToolContext, LoadedCustomTool } from "./types";

/**
 * Wrap a CustomTool into an AgentTool.
 * The wrapper injects the ToolContext into execute calls.
 */
export function wrapCustomTool(tool: CustomTool, getContext: () => CustomToolContext): AgentTool {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (toolCallId, params, signal, onUpdate, context) =>
			tool.execute(toolCallId, params, onUpdate, context ?? getContext(), signal),
		renderCall: tool.renderCall ? (args, theme) => tool.renderCall?.(args, theme as Theme) : undefined,
		renderResult: tool.renderResult
			? (result, options, theme) => tool.renderResult?.(result, options, theme as Theme)
			: undefined,
	};
}

/**
 * Wrap all loaded custom tools into AgentTools.
 */
export function wrapCustomTools(loadedTools: LoadedCustomTool[], getContext: () => CustomToolContext): AgentTool[] {
	return loadedTools.map((lt) => wrapCustomTool(lt.tool, getContext));
}
