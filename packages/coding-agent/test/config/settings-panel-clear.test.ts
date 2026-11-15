import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgDevAutoqaPushEndpoint } from "@oh-my-pi/pi-coding-agent/tools/settings";

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
	await Bun.write(
		configPath,
		YAML.stringify({ dev: { autoqaPush: { endpoint: "https://cfg.example" } }, temperature: 0.4 }),
	);
	await Settings.init({ cwd: projectDir, agentDir });
	const host = createSettingsHost();
	// The panel edits the configured layers: a setting without a configured value reads as unset.
	expect(host.get("dev.autoqaPush.token")).toBeUndefined();

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

	for (const ch of "auto qa push") selector.handleInput(ch);
	selector.handleInput("\n"); // open the text field
	selector.handleInput("\x15"); // clear it
	selector.handleInput("\n"); // submit

	expect(cfgDevAutoqaPushEndpoint.get(settings)).toBe("https://qa.omp.sh/v1/grievances");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
});
