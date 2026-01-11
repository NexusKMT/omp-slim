import { YAML } from "bun";
import { logger } from "./logger";

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, body } where body has frontmatter stripped
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = stripHtmlComments(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));

	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized };
	}

	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		// Replace tabs with spaces for YAML compatibility, use failsafe mode for robustness
		const frontmatter = YAML.parse(metadata.replaceAll("\t", "  ")) as Record<string, unknown> | null;
		return { frontmatter: frontmatter ?? {}, body: body };
	} catch (error) {
		logger.warn("Failed to parse YAML frontmatter", { error: String(error) });

		// Simple YAML parsing - just key: value pairs
		const frontmatter: Record<string, unknown> = {};
		for (const line of metadata.split("\n")) {
			const match = line.match(/^(\w+):\s*(.*)$/);
			if (match) {
				frontmatter[match[1]] = match[2].trim();
			}
		}

		return { frontmatter, body: body };
	}
}
