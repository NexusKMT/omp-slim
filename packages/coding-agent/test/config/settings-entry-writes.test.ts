import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgTaskAgentSoftRequestBudget } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Editing one request budget or one agent must persist only that entry: every entry another layer
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

	it("persists one request budget without the budgets a --config overlay supplies", async () => {
		const settings = await load({}, { task: { agentSoftRequestBudget: { smol: 1 } } });

		cfgTaskAgentSoftRequestBudget.setEntry(settings, "slow", 2);
		await settings.flush();

		expect(await readConfig()).toEqual({ task: { agentSoftRequestBudget: { slow: 2 } } });
		expect(cfgTaskAgentSoftRequestBudget.get(settings)).toEqual({
			smol: 1,
			slow: 2,
		});
	});

	it("addresses a dotted record key exactly, across an external edit, and deletes it on undefined", async () => {
		const settings = await load({ task: { agentSoftRequestBudget: { slow: 3 } } }, {});

		cfgTaskAgentSoftRequestBudget.setEntry(settings, "openai/gpt-5.4", 4);
		// Another process edits config.yml before the save merges this write into it.
		await Bun.write(
			configPath(),
			YAML.stringify({ temperature: 0.3, task: { agentSoftRequestBudget: { slow: 3 } } }),
		);
		await settings.flush();
		expect(await readConfig()).toEqual({
			temperature: 0.3,
			task: { agentSoftRequestBudget: { slow: 3, "openai/gpt-5.4": 4 } },
		});

		cfgTaskAgentSoftRequestBudget.setEntry(settings, "openai/gpt-5.4", undefined);
		await settings.flush();
		expect(await readConfig()).toEqual({ temperature: 0.3, task: { agentSoftRequestBudget: { slow: 3 } } });
		expect(cfgTaskAgentSoftRequestBudget.get(settings)).toEqual({ slow: 3 });
	});

	it("saves a whole-record write made while a save of one of its entries waits for the config lock", async () => {
		const settings = await load({ task: { agentSoftRequestBudget: { slow: 5, smol: 6 } } }, {});
		cfgTaskAgentSoftRequestBudget.setEntry(settings, "slow", 7);

		const lock = await acquireFileLock(configPath());
		let entrySave: Promise<void> | undefined;
		try {
			// This save captures the entry write, then cannot read config.yml before the whole record is set.
			entrySave = settings.flush();
			cfgTaskAgentSoftRequestBudget.set(settings, { slow: 8, smol: 9 });
		} finally {
			lock.release();
		}
		await entrySave;
		await settings.flush();

		expect(await readConfig()).toEqual({
			task: { agentSoftRequestBudget: { slow: 8, smol: 9 } },
		});
	});

	it.each([
		{
			edited: "another setting",
			external: { temperature: 0.3, task: { agentSoftRequestBudget: { slow: 5, smol: 6 } } },
			saved: { temperature: 0.3, task: { agentSoftRequestBudget: { slow: 8, smol: 9 } } },
		},
		{
			edited: "an entry only the whole-record write sets",
			external: { task: { agentSoftRequestBudget: { slow: 5, smol: 10 } } },
			saved: { task: { agentSoftRequestBudget: { slow: 8, smol: 10 } } },
		},
	])(
		"merges an entry write and a later whole-record write with an external edit of $edited",
		async ({ external, saved }) => {
			const settings = await load({ task: { agentSoftRequestBudget: { slow: 5, smol: 6 } } }, {});

			cfgTaskAgentSoftRequestBudget.setEntry(settings, "slow", 7);
			cfgTaskAgentSoftRequestBudget.set(settings, { slow: 8, smol: 9 });
			await Bun.write(configPath(), YAML.stringify(external));
			await settings.flush();

			expect(await readConfig()).toEqual(saved);
		},
	);

	it("writes an entry into a record malformed as a list, keeping the entries an overlay supplies", async () => {
		const settings = await load(
			{ task: { agentSoftRequestBudget: [] } },
			{ task: { agentSoftRequestBudget: { smol: 1 } } },
		);

		cfgTaskAgentSoftRequestBudget.setEntry(settings, "slow", 3);
		await settings.flush();

		expect(cfgTaskAgentSoftRequestBudget.get(settings)).toEqual({ smol: 1, slow: 3 });
		expect(await readConfig()).toEqual({ task: { agentSoftRequestBudget: { slow: 3 } } });
	});

	it("changes the persisted agent list by the toggled item only while an overlay supplies the list", async () => {
		const settings = await load({ task: { disabledAgents: ["reviewer"] } }, { task: { disabledAgents: ["scout"] } });

		cfgTaskDisabledAgents.setMember(settings, "dev", { member: true });
		cfgTaskDisabledAgents.setMember(settings, "reviewer", { member: false });
		await settings.flush();

		expect(await readConfig()).toEqual({ task: { disabledAgents: ["dev"] } });
	});
});
