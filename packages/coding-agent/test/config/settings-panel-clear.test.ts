import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { cfgTestEndpoint, installTestSettings } from "../helpers/test-settings";

let state: SettingsTestState | undefined;
let tempDir: TempDir;
let agentDir: string;
let projectDir: string;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("@pi-settings-panel-clear-");
	agentDir = tempDir.join("agent");
	projectDir = tempDir.join("project");
	for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

it("clearing a settings-panel text field removes the key from config.yml so its default applies again", async () => {
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ test: { endpoint: "https://cfg.example" }, temperature: 0.4 }));
	await Settings.init({ cwd: projectDir, agentDir });
	const host = createSettingsHost();
	// The panel edits the configured layers: a setting without a configured value reads as unset.
	expect(host.get("test.token")).toBeUndefined();

	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: host,
			plugins: createPluginSettingsHost(projectDir),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);

	for (const ch of "test endpoint") selector.handleInput(ch);
	selector.handleInput("\n"); // open the text field
	selector.handleInput("\x15"); // clear it
	selector.handleInput("\n"); // submit

	expect(cfgTestEndpoint.get(settings)).toBe("https://default.example");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
});
beforeEach(installTestSettings);
afterEach(() => vi.restoreAllMocks());
