import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadMcp(cwd: string, provider: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: [provider],
	});
	return result.items;
}

interface Fixture {
	/** Discovery provider id passed to `loadCapability`. */
	provider: string;
	/** Project-relative config file the importer reads. */
	file: string;
	/** File body carrying a single server with `enabled: false`. */
	content: string;
}

// Project-scoped config for each translated importer that previously dropped the
// per-server `enabled` flag (issue #7652). Codex/OpenCode/native already
// propagate it and are covered elsewhere.
const FIXTURES: Fixture[] = [
	{
		provider: "claude",
		file: ".claude/.mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "cursor",
		file: ".cursor/mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "gemini",
		file: ".gemini/settings.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "windsurf",
		file: ".windsurf/mcp_config.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "vscode",
		file: ".vscode/mcp.json",
		content: JSON.stringify({
			mcp: { servers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } } },
		}),
	},
];

describe("translated MCP importers propagate enabled: false", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	for (const { provider, file, content } of FIXTURES) {
		test(`${provider} carries enabled: false`, async () => {
			const filePath = path.join(tempDir, file);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content);

			const servers = await loadMcp(tempDir, provider);
			const server = servers.find(item => item.name === "markitdown");

			expect(server).toBeDefined();
			expect(server?.enabled).toBe(false);
		});
	}
});
