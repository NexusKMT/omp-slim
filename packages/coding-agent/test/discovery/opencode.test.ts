import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { type Settings, settingsCapability } from "@oh-my-pi/pi-coding-agent/capability/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadOpenCodeMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["opencode"],
	});
	return result.items;
}

async function loadOpenCodeSettings(cwd: string): Promise<Settings[]> {
	const result = await loadCapability<Settings>(settingsCapability.id, {
		cwd,
		providers: ["opencode"],
	});
	return result.items;
}

describe("OpenCode MCP discovery", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-opencode-mcp-"));
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("discovers commented JSONC config at user and project scopes", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		await fs.writeFile(
			path.join(userConfigDir, "opencode.jsonc"),
			`{
				// User-level OpenCode config
				"model": "user-model",
				"mcp": {
					"user-jsonc": {
						"type": "local",
						"command": ["user-server"]
					}
				}
			}`,
		);
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			`{
				// Project-level OpenCode config
				"model": "project-model",
				"mcp": {
					"project-jsonc": {
						"type": "local",
						"command": ["project-server"]
					}
				}
			}`,
		);

		const [servers, discoveredSettings] = await Promise.all([
			loadOpenCodeMcpConfig(projectDir),
			loadOpenCodeSettings(projectDir),
		]);

		expect(servers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "user-jsonc", command: "user-server" }),
				expect.objectContaining({ name: "project-jsonc", command: "project-server" }),
			]),
		);
		expect(discoveredSettings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ level: "user", data: expect.objectContaining({ model: "user-model" }) }),
				expect.objectContaining({ level: "project", data: expect.objectContaining({ model: "project-model" }) }),
			]),
		);
	});

	test("resolves same-named MCP servers by OpenCode precedence", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		// Lower precedence: user scope enables "shared" with the user command.
		await fs.writeFile(
			path.join(userConfigDir, "opencode.json"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["user-server"], enabled: true } },
			}),
		);
		// Higher precedence: project opencode.json disables it with a different command.
		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["project-json-server"], enabled: false } },
			}),
		);
		// Highest precedence within the project scope: opencode.jsonc wins outright.
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			`{ "mcp": { "shared": { "type": "local", "command": ["project-jsonc-server"], "enabled": false } } }`,
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);
		const shared = servers.filter(server => server.name === "shared");

		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({ command: "project-jsonc-server", enabled: false });
	});

	test("parses comments in opencode.json", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			`{
				// OpenCode parses either extension as JSONC.
				"mcp": {
					"commented-json": {
						"type": "local",
						"command": ["commented-server"]
					}
				}
			}`,
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);

		expect(servers).toEqual([
			expect.objectContaining({
				name: "commented-json",
				command: "commented-server",
			}),
		]);
	});
	test("normalizes array commands and OpenCode environment fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					sequentialthinking: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
						enabled: true,
					},
					github: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-github"],
						environment: {
							GITHUB_PERSONAL_ACCESS_TOKEN: "token",
						},
						enabled: true,
					},
					firecrawl: {
						type: "local",
						command: ["firecrawl-mcp"],
						env: {
							FIRECRAWL_API_KEY: "legacy-token",
						},
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const byName = Object.fromEntries(servers.map(server => [server.name, server]));

		expect(byName.sequentialthinking).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
			transport: "stdio",
		});
		expect(byName.github).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "token" },
			transport: "stdio",
		});
		expect(byName.firecrawl).toMatchObject({
			command: "firecrawl-mcp",
			env: { FIRECRAWL_API_KEY: "legacy-token" },
			transport: "stdio",
		});
		expect(byName.firecrawl?.args).toBeUndefined();
	});

	test("omits empty args for scalar OpenCode commands", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					plain: {
						type: "local",
						command: "server-bin",
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const server = servers.find(item => item.name === "plain");

		expect(server?.command).toBe("server-bin");
		expect(server?.args).toBeUndefined();
	});
});
