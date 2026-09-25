import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgProvidersMaxInFlightRequests, cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("Settings config-file watching", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-watch-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		// Persisted instances open agent.db under tempDir; close it before the directory goes away.
		AgentStorage.close();
		tempDir.removeSync();
	});

	/** Editor-style atomic replace: write a sibling temp file, then rename it over `file`. */
	const replaceFile = async (file: string, content: string) => {
		const tempPath = `${file}.edit.tmp`;
		await Bun.write(tempPath, content);
		await fs.promises.rename(tempPath, file);
	};
	const replaceConfig = (content: string) => replaceFile(path.join(agentDir, "config.yml"), content);

	/**
	 * Resolves once `settings` completes a layer refresh after `revision` (every completed reload
	 * rebuilds). A reload that keeps the last good values changes nothing observable, and fake timers
	 * cannot drive platform file events, so this polls the revision in real time.
	 */
	const reloadedSince = async (settings: Settings, revision: number) => {
		while (settings.revision === revision) await Bun.sleep(10);
	};

	/** Resolves once a watcher reload disables compaction in `settings`. */
	const compactionDisabled = (settings: Settings) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const stop = cfgCompactionEnabled.listen(settings, enabled => {
			if (enabled) return;
			stop();
			resolve();
		});
		return promise;
	};

	it("applies on-disk edits to watchers and keeps the last good values across malformed YAML", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ temperature: 0.1 }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();
		expect(cfgTemperature.get(settings)).toBe(0.1);

		let notify: ((value: number) => void) | undefined;
		const nextChange = () => {
			const { promise, resolve } = Promise.withResolvers<number>();
			notify = resolve;
			return promise;
		};
		cfgTemperature.listen(settings, value => notify?.(value));

		const firstChange = nextChange();
		await replaceConfig(YAML.stringify({ temperature: 0.7 }));
		expect(await firstChange).toBe(0.7);

		const beforeMalformed = settings.revision;
		await replaceConfig("temperature: [unterminated\n");
		await reloadedSince(settings, beforeMalformed);
		expect(cfgTemperature.get(settings)).toBe(0.7);

		const recovered = nextChange();
		await replaceConfig(YAML.stringify({ temperature: 0.3 }));
		expect(await recovered).toBe(0.3);
	});

	it("keeps the last good values when an on-disk edit fails validation", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ providers: { maxInFlightRequests: { openai: 2 } } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();

		const before = settings.revision;
		await replaceConfig(YAML.stringify({ providers: { maxInFlightRequests: { openai: 0 } } }));
		await reloadedSince(settings, before);
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
	});

	it("keeps only the invalid layer's last good values while the other layers still refresh", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ providers: { maxInFlightRequests: { openai: 2 } } }),
		);
		const projectSettings = path.join(getProjectAgentDir(projectDir), "settings.json");
		await Bun.write(projectSettings, JSON.stringify({ compaction: { enabled: true } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();

		const disabled = compactionDisabled(settings);
		await replaceConfig(YAML.stringify({ providers: { maxInFlightRequests: { openai: 0 } } }));
		await replaceFile(projectSettings, JSON.stringify({ compaction: { enabled: false } }));
		await disabled;
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2 });
	});

	it("keeps applying the current project's edits after a refused re-scope", async () => {
		// A persistently malformed file in the current project: its warning is already known, so live
		// reloads keep applying the project's other files.
		fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
		await Bun.write(path.join(projectDir, ".claude", "settings.json"), "{ not json");
		const projectSettings = path.join(getProjectAgentDir(projectDir), "settings.json");
		await Bun.write(projectSettings, JSON.stringify({ compaction: { enabled: true } }));
		const invalidProject = tempDir.join("invalid");
		fs.mkdirSync(getProjectAgentDir(invalidProject), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(invalidProject), "settings.json"),
			JSON.stringify({ providers: { maxInFlightRequests: { openai: -1 } } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.startWatching();

		await expect(settings.reloadForCwd(invalidProject)).rejects.toThrow(
			"Provider request limits must be positive numbers",
		);
		const disabled = compactionDisabled(settings);
		await replaceFile(projectSettings, JSON.stringify({ compaction: { enabled: false } }));
		await disabled;
	});
});
