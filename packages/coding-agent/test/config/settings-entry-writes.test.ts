import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Editing an agent list must persist only that entry: every entry another layer
// (a `--config` overlay) supplies stays out of config.yml.
describe("Settings entry-level writes", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;
	let overlayPath: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-entries-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		overlayPath = tempDir.join("overlay.yml");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const readConfig = async (): Promise<RawSettings> => YAML.parse(await Bun.file(configPath()).text()) as RawSettings;

	async function load(config: RawSettings, overlay: RawSettings): Promise<Settings> {
		await Bun.write(configPath(), YAML.stringify(config));
		await Bun.write(overlayPath, YAML.stringify(overlay));
		return Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] });
	}

	it("changes the persisted agent list by the toggled item only while an overlay supplies the list", async () => {
		const settings = await load({ task: { disabledAgents: ["reviewer"] } }, { task: { disabledAgents: ["scout"] } });

		cfgTaskDisabledAgents.setMember(settings, "dev", { member: true });
		cfgTaskDisabledAgents.setMember(settings, "reviewer", { member: false });
		await settings.flush();

		expect(await readConfig()).toEqual({ task: { disabledAgents: ["dev"] } });
	});
});
