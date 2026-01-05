import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import bashDescription from "../../prompts/tools/bash.md" with { type: "text" };
import { executeBash } from "../bash-executor";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateTail } from "./truncate";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: bashDescription,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			// Track output for streaming updates
			let currentOutput = "";

			const result = await executeBash(command, {
				cwd,
				timeout: timeout ? timeout * 1000 : undefined, // Convert to milliseconds
				signal,
				onChunk: (chunk) => {
					currentOutput += chunk;
					if (onUpdate) {
						const truncation = truncateTail(currentOutput);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
							},
						});
					}
				},
			});

			// Handle errors
			if (result.cancelled) {
				throw new Error(result.output || "Command aborted");
			}

			// Apply tail truncation for final output
			const truncation = truncateTail(result.output);
			let outputText = truncation.content || "(no output)";

			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: result.fullOutputPath,
				};

				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					const lastLineSize = formatSize(Buffer.byteLength(result.output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${result.fullOutputPath}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${result.fullOutputPath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${result.fullOutputPath}]`;
				}
			}

			if (result.exitCode !== 0 && result.exitCode !== undefined) {
				outputText += `\n\nCommand exited with code ${result.exitCode}`;
				throw new Error(outputText);
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());
