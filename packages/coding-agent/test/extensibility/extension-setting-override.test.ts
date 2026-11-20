import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Issue #13326: 18.3 removed `settings.override(path, value)`. Extensions reach the
// replacement through the `@oh-my-pi/pi-coding-agent/config/registry` subpath
// (documented in DOC.md#extensions § Runtime setting overrides); the override only
// lands if that import resolves to the host's registry, not a second copy.
const EXTENSION_SOURCE = `
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export default function (pi) {
	const autoResume = lookup("autoResume");
	if (!autoResume) throw new Error("autoResume is not registered");
	if (!autoResume.isConfigured(pi.pi.settings)) autoResume.override(pi.pi.settings, true);
}
`;

describe("extension runtime setting overrides", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@ext-setting-override-");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		// `Settings.init` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function loadOverrideExtension(globalConfig?: string): Promise<Settings> {
		const cwd = tempDir!.path();
		const agentDir = path.join(cwd, "agent");
		const extensionPath = path.join(cwd, "extension.ts");
		await Bun.write(extensionPath, EXTENSION_SOURCE);
		if (globalConfig) await Bun.write(path.join(agentDir, "config.yml"), globalConfig);
		const settings = await Settings.init({ cwd, agentDir });
		const result = await loadExtensions([extensionPath], cwd);
		expect(result.errors).toEqual([]);
		return settings;
	}

	it("applies a runtime override the host session observes", async () => {
		const settings = await loadOverrideExtension();
		const autoResume = lookup("autoResume")!;

		expect(autoResume.get(settings)).toBe(true);
		expect(autoResume.provenance(settings)).toBe("runtime");
	});

	it("sees the user's configured value and leaves it in place", async () => {
		const settings = await loadOverrideExtension("autoResume: false\n");
		const autoResume = lookup("autoResume")!;

		expect(autoResume.get(settings)).toBe(false);
		expect(autoResume.provenance(settings)).toBe("global");
	});
});
