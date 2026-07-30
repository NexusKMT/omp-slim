/**
 * `requestIdFormat` must survive the documented config path.
 *
 * The option is only useful if a value written in config actually reaches the
 * transport: discovery parses config into the canonical `MCPServer` shape and
 * `convertToLegacyConfig()` turns that back into the `MCPServerConfig` the
 * transports read. A field missing from either step silently degrades to the
 * snowflake-string default, which is the hang the option exists to avoid.
 *
 * Both OMP-native loaders are covered: `.omp/mcp.json` (native provider) and a
 * standalone project-root `.mcp.json` (mcp-json provider).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tempAgentDir = "";
let tempCwd = "";

beforeEach(async () => {
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-cwd-"));
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	clearFsCache();
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

async function loadFrom(file: string, mcpServers: Record<string, unknown>) {
	await Bun.write(path.join(tempCwd, file), JSON.stringify({ mcpServers }));
	clearFsCache();
	const { configs } = await loadAllMCPConfigs(tempCwd);
	return configs;
}

test("requestIdFormat from .omp/mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
		plain: { type: "stdio", command: "/bin/echo" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
	// Unset stays unset so the allocator keeps its snowflake-string default.
	expect(configs.plain?.requestIdFormat).toBeUndefined();
});

test("requestIdFormat from a standalone .mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(".mcp.json", {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
});

test("an unrecognized requestIdFormat is dropped rather than passed through", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		bogus: { type: "stdio", command: "/bin/echo", requestIdFormat: "integer" },
	});

	expect(configs.bogus).toBeDefined();
	expect(configs.bogus?.requestIdFormat).toBeUndefined();
});
