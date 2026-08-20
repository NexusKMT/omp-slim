import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("plugin config", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-config-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "omp-plugins.lock.json");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	async function writeLegacyLockfile(pluginName: string): Promise<void> {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "0.2.2", enabledFeatures: null, enabled: true },
				},
			}),
		);
	}

	test("set initializes missing settings in legacy runtime config", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await new PluginManager(tmpRoot).setPluginSetting(pluginName, "autoContext.enabled", true);

		const lock = await Bun.file(lockfile).json();
		expect(lock.settings[pluginName]).toEqual({ "autoContext.enabled": true });
		expect(lock.plugins[pluginName]).toEqual({ version: "0.2.2", enabledFeatures: null, enabled: true });
	});

	test("list treats missing settings in legacy runtime config as empty", async () => {
		const pluginName = "@gaodes/pi-graphify";
		await writeLegacyLockfile(pluginName);

		await expect(new PluginManager(tmpRoot).getPluginSettings(pluginName)).resolves.toEqual({});
	});

	test("resolves marketplace settings without restoring duplicate list entries", async () => {
		const pluginName = "omp-commit";
		const installPath = path.join(pluginsDir, "cache", pluginName);
		const pluginPath = path.join(pluginsDir, "node_modules", pluginName);
		await Bun.write(
			path.join(installPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "1.0.0",
				omp: {
					version: "1.0.0",
					settings: {
						mainBranchProtection: {
							type: "boolean",
							default: true,
						},
					},
				},
			}),
		);
		await fs.mkdir(path.dirname(pluginPath), { recursive: true });
		await fs.symlink(installPath, pluginPath, "dir");
		await Bun.write(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"omp-commit@market": [
						{
							scope: "user",
							installPath,
							version: "1.0.0",
							installedAt: "2026-08-20T00:00:00.000Z",
							lastUpdated: "2026-08-20T00:00:00.000Z",
						},
					],
				},
			}),
		);
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: {
					[pluginName]: { version: "1.0.0", enabledFeatures: null, enabled: true },
				},
				settings: {},
			}),
		);

		const manager = new PluginManager(tmpRoot);
		expect(await manager.list()).toEqual([]);
		expect((await manager.getPlugin(pluginName))?.manifest.settings?.mainBranchProtection?.default).toBe(true);

		await manager.setPluginSetting(pluginName, "mainBranchProtection", false);
		expect(await manager.getPluginSettings(pluginName)).toEqual({ mainBranchProtection: false });
	});

	test("resolves project-scoped marketplace plugin via the active project registry", async () => {
		const pluginName = "omp-commit";
		const installPath = path.join(tmpRoot, "cache", "omp-commit-project");
		await Bun.write(
			path.join(installPath, "package.json"),
			JSON.stringify({
				name: pluginName,
				version: "2.0.0",
				omp: {
					version: "2.0.0",
					settings: {
						splitMode: { type: "enum", values: ["auto", "manual"], default: "auto" },
					},
				},
			}),
		);
		// Project anchor (.omp/) plus a project-scoped marketplace registry entry —
		// none of it registered in the user plugin root.
		await fs.mkdir(path.join(tmpRoot, ".omp", "plugins"), { recursive: true });
		await Bun.write(
			path.join(tmpRoot, ".omp", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"omp-commit@market": [
						{
							scope: "project",
							installPath,
							version: "2.0.0",
							installedAt: "2026-08-20T00:00:00.000Z",
							lastUpdated: "2026-08-20T00:00:00.000Z",
						},
					],
				},
			}),
		);

		const manager = new PluginManager(tmpRoot);
		expect(await manager.list()).toEqual([]);
		expect((await manager.getPlugin(pluginName))?.manifest.settings?.splitMode?.default).toBe("auto");
	});
});
