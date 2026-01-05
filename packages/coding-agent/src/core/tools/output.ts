/**
 * Output tool for reading agent/task outputs by ID.
 *
 * Resolves IDs like "reviewer_0" to artifact paths in the current session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import outputDescription from "../../prompts/tools/output.md" with { type: "text" };
import type { SessionContext } from "./index";
import { getArtifactsDir } from "./task/artifacts";

const outputSchema = Type.Object({
	ids: Type.Array(Type.String(), {
		description: "Agent output IDs to read (e.g., ['reviewer_0', 'explore_1'])",
		minItems: 1,
	}),
	format: Type.Optional(
		Type.Union([Type.Literal("raw"), Type.Literal("json"), Type.Literal("stripped")], {
			description: "Output format: raw (default), json (structured), stripped (no ANSI)",
		}),
	),
});

/** Metadata for a single output file */
interface OutputProvenance {
	agent: string;
	index: number;
}

interface OutputEntry {
	id: string;
	path: string;
	lineCount: number;
	charCount: number;
	provenance?: OutputProvenance;
	previewLines?: string[];
}

export interface OutputToolDetails {
	outputs: OutputEntry[];
	notFound?: string[];
	availableIds?: string[];
}

/** Strip ANSI escape codes from text */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** List available output IDs in artifacts directory */
function listAvailableOutputs(artifactsDir: string): string[] {
	try {
		const files = fs.readdirSync(artifactsDir);
		return files.filter((f) => f.endsWith(".out.md")).map((f) => f.replace(".out.md", ""));
	} catch {
		return [];
	}
}

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function parseOutputProvenance(id: string): OutputProvenance | undefined {
	const match = id.match(/^(.*)_(\d+)$/);
	if (!match) return undefined;
	const agent = match[1];
	const index = Number(match[2]);
	if (!agent || Number.isNaN(index)) return undefined;
	return { agent, index };
}

function extractPreviewLines(content: string, maxLines: number): string[] {
	const lines = content.split("\n");
	const preview: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		preview.push(line);
		if (preview.length >= maxLines) break;
	}
	return preview;
}

export function createOutputTool(
	_cwd: string,
	sessionContext?: SessionContext,
): AgentTool<typeof outputSchema, OutputToolDetails> {
	return {
		name: "output",
		label: "Output",
		description: outputDescription,
		parameters: outputSchema,
		execute: async (
			_toolCallId: string,
			params: { ids: string[]; format?: "raw" | "json" | "stripped" },
		): Promise<{ content: TextContent[]; details: OutputToolDetails }> => {
			const sessionFile = sessionContext?.getSessionFile();

			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "No session - output artifacts unavailable" }],
					details: { outputs: [], notFound: params.ids },
				};
			}

			const artifactsDir = getArtifactsDir(sessionFile);
			if (!artifactsDir || !fs.existsSync(artifactsDir)) {
				return {
					content: [{ type: "text", text: "No artifacts directory found" }],
					details: { outputs: [], notFound: params.ids },
				};
			}

			const outputs: OutputEntry[] = [];
			const notFound: string[] = [];
			const outputContentById = new Map<string, string>();
			const format = params.format ?? "raw";

			for (const id of params.ids) {
				const outputPath = path.join(artifactsDir, `${id}.out.md`);

				if (!fs.existsSync(outputPath)) {
					notFound.push(id);
					continue;
				}

				const content = fs.readFileSync(outputPath, "utf-8");
				outputContentById.set(id, content);
				outputs.push({
					id,
					path: outputPath,
					lineCount: content.split("\n").length,
					charCount: content.length,
					provenance: parseOutputProvenance(id),
					previewLines: extractPreviewLines(content, 4),
				});
			}

			// Error case: some IDs not found
			if (notFound.length > 0) {
				const available = listAvailableOutputs(artifactsDir);
				const errorMsg =
					available.length > 0
						? `Not found: ${notFound.join(", ")}\nAvailable: ${available.join(", ")}`
						: `Not found: ${notFound.join(", ")}\nNo outputs available in current session`;

				return {
					content: [{ type: "text", text: errorMsg }],
					details: { outputs, notFound, availableIds: available },
				};
			}

			// Success: build response based on format
			let contentText: string;

			if (format === "json") {
				const jsonData = outputs.map((o) => ({
					id: o.id,
					lineCount: o.lineCount,
					charCount: o.charCount,
					provenance: o.provenance,
					previewLines: o.previewLines,
					content: outputContentById.get(o.id) ?? "",
				}));
				contentText = JSON.stringify(jsonData, null, 2);
			} else {
				// raw or stripped
				const parts = outputs.map((o) => {
					let content = outputContentById.get(o.id) ?? "";
					if (format === "stripped") {
						content = stripAnsi(content);
					}
					// Add header for multiple outputs
					if (outputs.length > 1) {
						return `=== ${o.id} (${o.lineCount} lines, ${formatBytes(o.charCount)}) ===\n${content}`;
					}
					return content;
				});
				contentText = parts.join("\n\n");
			}

			return {
				content: [{ type: "text", text: contentText }],
				details: { outputs },
			};
		},
	};
}

/** Default output tool using process.cwd() - for backwards compatibility */
export const outputTool = createOutputTool(process.cwd());
