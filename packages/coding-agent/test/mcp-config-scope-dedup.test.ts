/**
 * Regression: project-scope filtering must run BEFORE MCP connection-equivalence
 * deduplication. The native provider orders project entries before user entries,
 * so a project server can shadow a differently-named but connection-equivalent
 * user server during dedup. When `enableProjectConfig` is false the project entry
 * is then removed, and without pre-dedup scope filtering no server would survive.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/builtin";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const CONNECTION = { type: "http", url: "https://mcp.example/mcp" } as const;

async function writeMcpJson(dir: string, servers: Record<string, unknown>): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("MCP scope filtering precedes connection-equivalence deduplication", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		// Same connection identity under two distinct names, one per scope.
		await writeMcpJson(path.join(projectDir, ".omp"), { projcontext: CONNECTION });
		await writeMcpJson(userAgentDir, { usercontext: CONNECTION });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("keeps the user server when project config is disabled", async () => {
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: false, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);
		expect(result.sources.usercontext?.level).toBe("user");
	});

	test("collapses the equivalent alias to the higher-priority project name when enabled", async () => {
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: true, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["projcontext"]);
		expect(result.sources.projcontext?.level).toBe("project");
	});
});
