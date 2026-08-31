import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Issue #10397: pi-vim (and any pi extension) does, at module/session_start scope:
//   const s = SettingsManager.create(cwd), g = s.getGlobalSettings(), p = s.getProjectSettings();
// Upstream Pi's `SettingsManager.create(cwd)` is synchronous and returns a manager
// exposing `getGlobalSettings()`/`getProjectSettings()`. The omp shim previously
// returned `Settings.init(...)` — a `Promise<Settings>` with no such methods — so the
// extension crashed on startup and never registered its editor component. These tests
// pin the sync shape and the raw-layer accessors through the public package specifier.

describe("legacy pi SettingsManager shim (issue #10397)", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-manager-shim-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		tempDir?.[Symbol.dispose]?.();
	});

	it("create(cwd) is synchronous and exposes getGlobalSettings/getProjectSettings", async () => {
		await Settings.init({ cwd: projectDir, agentDir });

		const s = SettingsManager.create(projectDir);

		// The pi-vim crash: `create()` returned a Promise, so these were undefined.
		expect(s).not.toBeInstanceOf(Promise);
		expect(typeof s.getGlobalSettings).toBe("function");
		expect(typeof s.getProjectSettings).toBe("function");
	});

	it("reads arbitrary extension-namespaced keys from the global and project layers", async () => {
		// Keys the typed, schema-bound `get(path)` cannot reach — an extension's own block.
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ piVim: { mode: "normal" } }, null, 2));
		fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
		await Bun.write(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({ piVim: { leader: "," } }));

		await Settings.init({ cwd: projectDir, agentDir });
		const s = SettingsManager.create(projectDir);

		expect(s.getGlobalSettings().piVim).toEqual({ mode: "normal" });
		expect(s.getProjectSettings().piVim).toEqual({ leader: "," });
	});

	it("returns a deep clone so callers cannot mutate internal state", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ piVim: { mode: "normal" } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		const s = SettingsManager.create(projectDir);

		const first = s.getGlobalSettings();
		const second = s.getGlobalSettings();

		// structuredClone: each call yields a fresh, deeply distinct tree, so a
		// caller mutating `first.piVim` can never reach the manager's internals.
		expect(first).not.toBe(second);
		expect(first.piVim).not.toBe(second.piVim);
		expect(first).toEqual(second);
	});

	it("returns an isolated instance with the accessors before init and via inMemory()", () => {
		resetSettingsForTest();

		const created = SettingsManager.create(projectDir);
		expect(created).not.toBeInstanceOf(Promise);
		expect(typeof created.getGlobalSettings).toBe("function");
		expect(created.getGlobalSettings()).toEqual({});

		const inMemory = SettingsManager.inMemory();
		expect(typeof inMemory.getProjectSettings).toBe("function");
		expect(inMemory.getProjectSettings()).toEqual({});
	});

	it("resolves settings by requested cwd instead of leaking another session's singleton", async () => {
		// Session B is an SDK session with its own loaded Settings for a different
		// project. Its cwd must win over the global singleton session A initializes.
		const projectB = tempDir.join("project-b");
		fs.mkdirSync(getProjectAgentDir(projectB), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(projectB, ".claude"), { recursive: true });
		await Bun.write(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({ piVim: { session: "a" } }));
		await Bun.write(path.join(projectB, ".claude", "settings.json"), JSON.stringify({ piVim: { session: "b" } }));

		const singleton = await Settings.init({ cwd: projectDir, agentDir });
		const sessionB = await Settings.loadIsolated({ cwd: projectB, agentDir });

		expect(SettingsManager.create(projectDir)).toBe(singleton);
		expect(SettingsManager.create(projectB)).toBe(sessionB);
		expect(SettingsManager.create(projectB).getProjectSettings().piVim).toEqual({ session: "b" });
	});
});
