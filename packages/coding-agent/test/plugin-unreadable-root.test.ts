import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];
const restore: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	// Cleanup needs the manifests back: a 000 file blocks its own removal.
	for (const file of restore.splice(0)) {
		await fs.chmod(file, 0o600).catch(() => {});
	}
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/** A plugins root holding one declared, loadable plugin. */
async function plantRoot(prefix: string): Promise<{ home: string; cwd: string; manifest: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	await fs.mkdir(cwd, { recursive: true });

	const declaredDir = path.join(pluginsDir, "node_modules", "declared-plugin");
	await fs.mkdir(declaredDir, { recursive: true });
	await writeJson(path.join(declaredDir, "package.json"), {
		name: "declared-plugin",
		version: "1.0.0",
		omp: { extensions: ["ext.ts"] },
	});

	const manifest = path.join(pluginsDir, "package.json");
	await writeJson(manifest, { dependencies: { "declared-plugin": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: { "declared-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	return { home, cwd, manifest };
}

// Regression: the plugins manifest is not always readable. A sandboxed run, a
// restrictive mode, or a manifest symlinked into a denied path all surface as
// EACCES/EPERM, and the loader rethrew them — aborting plugin tool-path
// collection and killing agent and subagent startup with a filesystem error
// far from its cause. An unreadable root is skipped; a readable one still
// loads, so the skip cannot hide a working plugin set.
test("an unreadable plugins root is skipped instead of failing plugin collection", async () => {
	const readable = await plantRoot("omp-plugin-readable-");
	expect((await getEnabledPlugins(readable.cwd, { home: readable.home })).map(plugin => plugin.name)).toEqual([
		"declared-plugin",
	]);

	const denied = await plantRoot("omp-plugin-denied-");
	await fs.chmod(denied.manifest, 0o000);
	restore.push(denied.manifest);
	expect(await getEnabledPlugins(denied.cwd, { home: denied.home })).toEqual([]);
});
