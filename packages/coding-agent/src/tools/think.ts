import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";

/** Whether the configured Chat model permits disabling reasoning. */
export function supportsExternalThinking(model: Model | null | undefined): boolean {
	return model?.api === "openai-completions" && model.thinking?.requiresEffort !== true;
}

const thinkSchema = type({
	thoughts: type("string").describe("private scratchpad; not shown to user"),
	"+": "reject",
}).describe("private scratchpad; not shown to user");

type ThinkParams = typeof thinkSchema.infer;

interface ThinkToolDetails {
	recorded: true;
}

/** Records private scratchpad thoughts while native model reasoning is disabled. */
export class ThinkTool implements AgentTool<typeof thinkSchema, ThinkToolDetails> {
	readonly name = "think";
	readonly approval = "read" as const;
	readonly label = "Think";
	readonly summary = "Record private scratchpad thoughts";
	readonly description = "private scratchpad; not shown to user";
	readonly parameters = thinkSchema;
	readonly strict = true;
	readonly intent = "omit" as const;

	async execute(_toolCallId: string, _params: ThinkParams): Promise<AgentToolResult<ThinkToolDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "------",
				},
			],
			details: { recorded: true },
		};
	}
}
