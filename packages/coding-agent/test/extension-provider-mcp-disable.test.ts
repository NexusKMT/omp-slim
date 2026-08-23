/**
 * Provider master-disable must drop live MCP tools without rewriting mcp.json.
 *
 * Disabling a discovery provider used to only flip provider state and refresh
 * the dashboard, leaving already-connected MCP servers registered/callable.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	enableProvider,
	initializeWithSettings,
	isProviderEnabled,
	reset as resetDiscoveryCache,
} from "@oh-my-pi/pi-coding-agent/discovery";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { ExtensionDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";
import { restoreEnvValue } from "./helpers/settings-test-state";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SERVER = "bravo";
const TOOL = `mcp__${SERVER}_${manyToolName(0)}`;
const PROVIDER = "vscode";

beforeAll(async () => {
	await initTheme(false);
});

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

function waitUntil(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const start = Date.now();
	const tick = () => {
		if (predicate()) {
			resolve();
			return;
		}
		if (Date.now() - start > timeoutMs) {
			reject(new Error(`timed out waiting for ${label}`));
			return;
		}
		setTimeout(tick, 15);
	};
	tick();
	return promise;
}

describe("provider master-disable disconnects live MCP", () => {
	let projectDir = "";
	let userAgentDir = "";
	let manager: MCPManager;
	let originalAgentDirEnv: string | undefined;
	let vscodeConfigPath = "";

	beforeEach(async () => {
		resetSettingsForTest();
		enableProvider(PROVIDER);
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-mcp-"));
		userAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-mcp-user-"));
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(userAgentDir);
		vscodeConfigPath = path.join(projectDir, ".vscode", "mcp.json");
		fs.mkdirSync(path.dirname(vscodeConfigPath), { recursive: true });
		fs.writeFileSync(
			vscodeConfigPath,
			`${JSON.stringify({
				mcp: {
					servers: {
						[SERVER]: {
							command: process.execPath,
							args: [FIXTURE_PATH],
						},
					},
				},
			})}\n`,
		);
		manager = new MCPManager(projectDir);
		resetDiscoveryCache();
	});

	afterEach(async () => {
		enableProvider(PROVIDER);
		resetSettingsForTest();
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);

		__resetDirsFromEnvForTests();
		await manager.disconnectAll();
		removeSyncWithRetries(projectDir);
		removeSyncWithRetries(userAgentDir);
	});

	test("disabling the provider disconnects its MCP server and drops tools", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);

		const discovered = await loadAllExtensions(projectDir, []);
		const discoveredRow = discovered.find(ext => ext.id === `mcp:${SERVER}`);
		expect(discoveredRow?.source.provider).toBe(PROVIDER);
		expect(discoveredRow?.state).toBe("active");

		await manager.connectServers({ [SERVER]: fixtureConfig() }, {});
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
		expect(manager.getTools().map(tool => tool.name)).toContain(TOOL);
		expect(manager.getTools()).toHaveLength(MANY_TOOL_COUNT);

		const refreshed: string[][] = [];
		const dashboard = await ExtensionDashboard.create({
			cwd: projectDir,
			settings,
			mcpManager: manager,
			onMcpToolsChanged: tools => {
				refreshed.push(tools.map(tool => tool.name));
			},
		});

		let onVscodeTab = false;
		for (let i = 0; i < 40; i++) {
			const text = Bun.stripANSI(dashboard.render(120).join("\n"));
			if (text.includes("Enable VS Code") && text.includes("Master Switch")) {
				onVscodeTab = true;
				break;
			}
			dashboard.handleInput("\x1b[C");
		}
		expect(onVscodeTab).toBe(true);

		dashboard.handleInput(" ");
		await waitUntil(
			() =>
				manager.getConnectionStatus(SERVER) === "disconnected" &&
				!manager.getTools().some(tool => tool.mcpServerName === SERVER),
			"provider MCP disconnect",
		);

		expect(isProviderEnabled(PROVIDER)).toBe(false);
		expect(manager.getTools()).toEqual([]);
		expect(refreshed.at(-1)).toEqual([]);

		const disabledUi = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(disabledUi).toContain("Enable vscode");
		expect(disabledUi).toContain("Master Switch");
		expect(disabledUi).toContain("VS Code");
		expect(JSON.parse(fs.readFileSync(vscodeConfigPath, "utf8")).mcp.servers[SERVER].enabled).not.toBe(false);

		dashboard.handleInput(" ");
		await waitUntil(() => isProviderEnabled(PROVIDER), "provider re-enable");
		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
		expect(manager.getTools().some(tool => tool.mcpServerName === SERVER)).toBe(false);

		dashboard.dispose();
	}, 20_000);
});
