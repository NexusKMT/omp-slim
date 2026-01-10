import { join, resolve } from "node:path";
import Handlebars from "handlebars";
import { CONFIG_DIR_NAME, getPromptsDir } from "../config";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

export interface TemplateContext extends Record<string, unknown> {
	args?: string[];
	ARGUMENTS?: string;
	arguments?: string;
}

const handlebars = Handlebars.create();

handlebars.registerHelper("arg", function (this: TemplateContext, index: number | string): string {
	const args = this.args ?? [];
	const parsedIndex = typeof index === "number" ? index : Number.parseInt(index, 10);
	if (!Number.isFinite(parsedIndex)) return "";
	const zeroBased = parsedIndex - 1;
	if (zeroBased < 0) return "";
	return args[zeroBased] ?? "";
});

export function renderPromptTemplate(template: string, context: TemplateContext = {}): string {
	const compiled = handlebars.compile(template, { noEscape: true, strict: false });
	const rendered = compiled(context ?? {});
	return optimizePromptLayout(rendered);
}

function optimizePromptLayout(input: string): string {
	// 1) strip CR / normalize line endings
	let s = input.replace(/\r\n?/g, "\n");

	// normalize NBSP -> space
	s = s.replace(/\u00A0/g, " ");

	const lines = s.split("\n").map((line) => {
		// 2) remove trailing whitespace (spaces/tabs) per line
		let l = line.replace(/[ \t]+$/g, "");

		// 3) lines with only whitespace -> empty line
		if (/^[ \t]*$/.test(l)) return "";

		// 4) normalize leading indentation: every 2 spaces -> \t (preserve leftover 1 space)
		//    NOTE: This is intentionally *only* leading indentation to avoid mangling prose.
		const m = l.match(/^[ \t]+/);
		if (m) {
			const indent = m[0];
			const rest = l.slice(indent.length);

			let out = "";
			let spaces = 0;

			for (const ch of indent) {
				if (ch === "\t") {
					// flush pending spaces before existing tab
					out += "\t".repeat(Math.floor(spaces / 2));
					if (spaces % 2) out += " ";
					spaces = 0;
					out += "\t";
				} else {
					spaces++;
				}
			}

			out += "\t".repeat(Math.floor(spaces / 2));
			if (spaces % 2) out += " ";

			l = out + rest;
		}

		return l;
	});

	s = lines.join("\n");

	// 5) collapse excessive blank lines
	s = s.replace(/\n{3,}/g, "\n\n");

	return s.trim();
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, content } where content has frontmatter stripped
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; content: string } {
	const frontmatter: Record<string, string> = {};

	if (!content.startsWith("---")) {
		return { frontmatter, content };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, content };
	}

	const frontmatterBlock = content.slice(4, endIndex);
	const remainingContent = content.slice(endIndex + 4).trim();

	// Simple YAML parsing - just key: value pairs
	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^(\w+):\s*(.*)$/);
		if (match) {
			frontmatter[match[1]] = match[2].trim();
		}
	}

	return { frontmatter, content: remainingContent };
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports $1, $2, ... for positional args, $@ and $ARGUMENTS for all args
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args FIRST (before wildcards)
	// This prevents wildcard replacement values containing $<digit> patterns from being re-substituted
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Pre-compute all args joined (optimization)
	const allArgs = args.join(" ");

	// Replace $ARGUMENTS with all args joined (new syntax, aligns with Claude, Codex, OpenCode)
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// Replace $@ with all args joined (existing syntax)
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as prompt templates
 */
async function loadTemplatesFromDir(
	dir: string,
	source: "user" | "project",
	subdir: string = "",
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];

	try {
		const stat = await Bun.file(`${dir}/.`).exists();
		if (!stat) return templates;
	} catch {
		return templates;
	}

	try {
		const glob = new Bun.Glob("**/*");
		const entries = [];
		for await (const entry of glob.scan({ cwd: dir, absolute: false, onlyFiles: false })) {
			entries.push(entry);
		}

		// Group by path depth to process directories before deeply nested files
		entries.sort((a, b) => a.split("/").length - b.split("/").length);

		for (const entry of entries) {
			const fullPath = join(dir, entry);
			const file = Bun.file(fullPath);

			try {
				const stat = await file.exists();
				if (!stat) continue;

				if (entry.endsWith(".md")) {
					const rawContent = await file.text();
					const { frontmatter, content } = parseFrontmatter(rawContent);

					const name = entry.split("/").pop()!.slice(0, -3); // Remove .md extension

					// Build source string based on subdirectory structure
					const entryDir = entry.includes("/") ? entry.split("/").slice(0, -1).join(":") : "";
					const fullSubdir = subdir && entryDir ? `${subdir}:${entryDir}` : entryDir || subdir;

					let sourceStr: string;
					if (source === "user") {
						sourceStr = fullSubdir ? `(user:${fullSubdir})` : "(user)";
					} else {
						sourceStr = fullSubdir ? `(project:${fullSubdir})` : "(project)";
					}

					// Get description from frontmatter or first non-empty line
					let description = frontmatter.description || "";
					if (!description) {
						const firstLine = content.split("\n").find((line) => line.trim());
						if (firstLine) {
							// Truncate if too long
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

					// Append source to description
					description = description ? `${description} ${sourceStr}` : sourceStr;

					templates.push({
						name,
						description,
						content,
						source: sourceStr,
					});
				}
			} catch (_error) {
				// Silently skip files that can't be read
			}
		}
	} catch (_error) {
		// Silently skip directories that can't be read
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global templates. Default: from getPromptsDir() */
	agentDir?: string;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 */
export async function loadPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplate[]> {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getPromptsDir();

	const templates: PromptTemplate[] = [];

	// 1. Load global templates from agentDir/prompts/
	// Note: if agentDir is provided, it should be the agent dir, not the prompts dir
	const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	templates.push(...(await loadTemplatesFromDir(globalPromptsDir, "user")));

	// 2. Load project templates from cwd/{CONFIG_DIR_NAME}/prompts/
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
	templates.push(...(await loadTemplatesFromDir(projectPromptsDir, "project")));

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const substituted = substituteArgs(template.content, args);
		return renderPromptTemplate(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
	}

	return text;
}
