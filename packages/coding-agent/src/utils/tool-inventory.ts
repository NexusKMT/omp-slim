import type { Tool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

/** Human-readable tool descriptions shared by verbose prompts and local dumps. */
export function renderToolInventory(tools: readonly Tool[]): string {
	return tools
		.map(tool => `### ${tool.name}\n\n${tool.description}\n\nParameters: ${JSON.stringify(toolWireSchema(tool))}`)
		.join("\n\n");
}
