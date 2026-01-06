import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import editDescription from "../../prompts/tools/edit.md" with { type: "text" };
import {
	DEFAULT_FUZZY_THRESHOLD,
	detectLineEnding,
	EditMatchError,
	findEditMatch,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff";
import { type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "./lsp/index";
import { resolveToCwd } from "./path-utils";

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description: "Text to find and replace (high-confidence fuzzy matching for whitespace/indentation is always on)",
	}),
	newText: Type.String({ description: "New text to replace the old text with" }),
	all: Type.Optional(Type.Boolean({ description: "Replace all occurrences instead of requiring unique match" })),
});

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
}

export interface EditToolOptions {
	/** Whether to accept high-confidence fuzzy matches for whitespace/indentation (default: true) */
	fuzzyMatch?: boolean;
	/** Writethrough callback to get LSP diagnostics after editing a file */
	writethrough?: WritethroughCallback;
}

export function createEditTool(cwd: string, options: EditToolOptions = {}): AgentTool<typeof editSchema> {
	const allowFuzzy = options.fuzzyMatch ?? true;
	const writethrough = options.writethrough ?? writethroughNoop;
	return {
		name: "edit",
		label: "Edit",
		description: editDescription,
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path, oldText, newText, all }: { path: string; oldText: string; newText: string; all?: boolean },
			signal?: AbortSignal,
		) => {
			// Reject .ipynb files - use NotebookEdit tool instead
			if (path.endsWith(".ipynb")) {
				throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
			}

			const absolutePath = resolveToCwd(path, cwd);

			const file = Bun.file(absolutePath);
			if (!(await file.exists())) {
				throw new Error(`File not found: ${path}`);
			}

			const rawContent = await file.text();

			// Strip BOM before matching (LLM won't include invisible BOM in oldText)
			const { bom, text: content } = stripBom(rawContent);

			const originalEnding = detectLineEnding(content);
			const normalizedContent = normalizeToLF(content);
			const normalizedOldText = normalizeToLF(oldText);
			const normalizedNewText = normalizeToLF(newText);

			let normalizedNewContent: string;
			let replacementCount = 0;

			if (all) {
				// Replace all occurrences mode with fuzzy matching
				normalizedNewContent = normalizedContent;

				// First check: if exact matches exist, use simple replaceAll
				const exactCount = normalizedContent.split(normalizedOldText).length - 1;
				if (exactCount > 0) {
					normalizedNewContent = normalizedContent.split(normalizedOldText).join(normalizedNewText);
					replacementCount = exactCount;
				} else {
					// No exact matches - try fuzzy matching iteratively
					while (true) {
						const matchOutcome = findEditMatch(normalizedNewContent, normalizedOldText, {
							allowFuzzy,
							similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
						});

						// In all mode, use closest match if it passes threshold (even with multiple matches)
						const match =
							matchOutcome.match ||
							(allowFuzzy && matchOutcome.closest && matchOutcome.closest.confidence >= DEFAULT_FUZZY_THRESHOLD
								? matchOutcome.closest
								: undefined);

						if (!match) {
							if (replacementCount === 0) {
								throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
									allowFuzzy,
									similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
									fuzzyMatches: matchOutcome.fuzzyMatches,
								});
							}
							break;
						}

						normalizedNewContent =
							normalizedNewContent.substring(0, match.startIndex) +
							normalizedNewText +
							normalizedNewContent.substring(match.startIndex + match.actualText.length);
						replacementCount++;
					}
				}
			} else {
				// Single replacement mode with fuzzy matching
				const matchOutcome = findEditMatch(normalizedContent, normalizedOldText, {
					allowFuzzy,
					similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
				});

				if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
					throw new Error(
						`Found ${matchOutcome.occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique, or use all: true to replace all.`,
					);
				}

				if (!matchOutcome.match) {
					throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
						allowFuzzy,
						similarityThreshold: DEFAULT_FUZZY_THRESHOLD,
						fuzzyMatches: matchOutcome.fuzzyMatches,
					});
				}

				const match = matchOutcome.match;
				normalizedNewContent =
					normalizedContent.substring(0, match.startIndex) +
					normalizedNewText +
					normalizedContent.substring(match.startIndex + match.actualText.length);
				replacementCount = 1;
			}

			// Verify the replacement actually changed something
			if (normalizedContent === normalizedNewContent) {
				throw new Error(
					`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
				);
			}

			const finalContent = bom + restoreLineEndings(normalizedNewContent, originalEnding);
			const diagnostics = await writethrough(absolutePath, finalContent, signal, file);

			const diffResult = generateDiffString(normalizedContent, normalizedNewContent);

			// Build result text
			let resultText =
				replacementCount > 1
					? `Successfully replaced ${replacementCount} occurrences in ${path}.`
					: `Successfully replaced text in ${path}.`;

			const messages = diagnostics?.messages;
			if (messages && messages.length > 0) {
				resultText += `\n\nLSP Diagnostics (${diagnostics.summary}):\n`;
				resultText += messages.map((d) => `  ${d}`).join("\n");
			}

			return {
				content: [
					{
						type: "text",
						text: resultText,
					},
				],
				details: {
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
					diagnostics: diagnostics,
				},
			};
		},
	};
}

/** Default edit tool using process.cwd() - for backwards compatibility */
export const editTool = createEditTool(process.cwd());
