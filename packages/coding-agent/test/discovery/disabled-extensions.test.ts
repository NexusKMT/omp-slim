import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disableProvider,
	enableProvider,
	initializeWithSettings,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/discovery";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		process.env.USERPROFILE = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".omp", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("USERPROFILE", originalUserProfile);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});

	test("uses the session's disabled context list instead of global settings", async () => {
		initializeWithSettings(Settings.isolated({ disabledExtensions: [] }));
		const disabledIds = ["context-file:project:AGENTS.md"];
		const contextPath = path.join(tempDir, ".omp", "AGENTS.md");
		const disabled = (await loadAllExtensions(tempDir, disabledIds)).find(row => row.path === contextPath);
		expect(disabled?.state).toBe("disabled");

		const active = (await loadAllExtensions(tempDir, [])).find(row => row.path === contextPath);
		expect(active?.state).toBe("active");
	});

	test("uses an empty disabled snapshot when the caller omits it", async () => {
		const contextPath = path.join(tempDir, ".omp", "AGENTS.md");
		const runtime = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		expect(runtime.items).toHaveLength(0);
		const dashboard = await loadAllExtensions(tempDir);
		expect(dashboard.find(row => row.path === contextPath)?.state).toBe("active");
	});

	test("lists configured package modules exactly as the loader gates them (#17736)", async () => {
		const fleet = path.join(tempDir, "fleet");
		const hello = path.join(fleet, "extensions", "hello.ts");
		const loose = path.join(tempDir, "loose.ts");
		await Bun.write(
			path.join(fleet, "package.json"),
			JSON.stringify({ omp: { extensions: ["./extensions/hello.ts"] } }),
		);
		await Bun.write(hello, "export default function hello() {}\n");
		await Bun.write(loose, "export default function loose() {}\n");
		const roots: EffectiveExtensionRoots = {
			explicit: [],
			mode: "merge",
			configured: [fleet, loose],
			configuredLevel: "project",
		};
		const moduleRows = async (disabledIds: string[]) =>
			(await loadAllExtensions(tempDir, disabledIds, roots)).filter(row => row.kind === "extension-module");

		// The provider switch does not stop the loader from importing configured
		// modules, so it must not mark their rows disabled either.
		disableProvider("omp-plugins");
		try {
			const rows = await moduleRows([]);
			expect(rows.map(row => [row.id, row.path, row.source.provider, row.source.level, row.state])).toEqual([
				["extension-module:hello", hello, "omp-plugins", "project", "active"],
			]);
		} finally {
			enableProvider("omp-plugins");
		}

		// Toggling the row's id removes the module from the load set; the configured
		// file path stays loaded regardless, which is why it has no row.
		const disabledIds = ["extension-module:hello"];
		const [disabledRow] = await moduleRows(disabledIds);
		expect([disabledRow?.state, disabledRow?.disabledReason]).toEqual(["disabled", "item-disabled"]);
		const loaded = await discoverExtensionPaths([...roots.configured], tempDir, disabledIds);
		expect(loaded).not.toContain(hello);
		expect(loaded).toContain(loose);
	});

	test("omits a package module the package's hook factory already loads", async () => {
		const fleet = path.join(tempDir, "fleet");
		const guard = path.join(fleet, "hooks", "pre", "guard.ts");
		await Bun.write(
			path.join(fleet, "package.json"),
			JSON.stringify({ omp: { extensions: ["./hooks/pre/guard.ts"] } }),
		);
		await Bun.write(guard, "export default function guard() {}\n");
		// The loader's hook discovery reads configured package roots from disk.
		await Bun.write(path.join(tempHomeDir, ".omp", "agent", "config.yml"), `extensions:\n  - ${fleet}\n`);
		const roots: EffectiveExtensionRoots = {
			explicit: [],
			mode: "merge",
			configured: [fleet],
			configuredLevel: "user",
		};
		const moduleIds = async (disabledIds: string[]) =>
			(await loadAllExtensions(tempDir, disabledIds, roots))
				.filter(row => row.kind === "extension-module")
				.map(row => row.id);

		// Hook discovery adds the file first, so the module id cannot unload it: no row.
		expect(await discoverExtensionPaths([fleet], tempDir, ["extension-module:guard"])).toContain(guard);
		expect(await moduleIds([])).toEqual([]);

		// With the hook disabled, only the package lane loads the file and the module id gates it.
		const hookOff = ["hook:pre:guard:guard.ts"];
		expect(await moduleIds(hookOff)).toEqual(["extension-module:guard"]);
		expect(await discoverExtensionPaths([fleet], tempDir, [...hookOff, "extension-module:guard"])).not.toContain(
			guard,
		);
	});
});
