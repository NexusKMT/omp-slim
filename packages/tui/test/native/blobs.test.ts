import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

describe("native image blob lifetime", () => {
	const cases = [
		...["base64", "image", "attachment", "svg", "snapcompact"].map(source => ({
			name: `releases discarded ${source} payloads after uploading them`,
			fixture: "blob-lifetime.ts",
			source,
		})),
		{
			name: "keeps pending, shared, remounted, and replayed images available",
			fixture: "blob-replay.ts",
			source: "",
		},
	];
	for (const { name, fixture, source } of cases) {
		it(
			name,
			async () => {
				await using root = await TempDir.create("@omp-native-blobs-");
				const env: NodeJS.ProcessEnv = {
					...process.env,
					PI_CONFIG_DIR: path.relative(os.homedir(), root.join("config")),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_TEST_SESSION_OWNERS_DIR: root.join("session-owners"),
					XDG_CONFIG_HOME: root.join("xdg-config"),
					XDG_DATA_HOME: root.join("data"),
					XDG_STATE_HOME: root.join("state"),
					XDG_CACHE_HOME: root.join("cache"),
					PI_TUI_NATIVE: "1",
				};
				delete env.OMP_PROFILE;
				delete env.PI_PROFILE;
				await Promise.all(
					["config", "agent", "session-owners", "xdg-config", "data/omp", "state/omp", "cache/omp"].map(dir =>
						fs.mkdir(root.join(dir), { recursive: true }),
					),
				);
				const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", fixture), source], {
					stdout: "pipe",
					stderr: "pipe",
					env,
				});
				const timeout = setTimeout(() => child.kill(), 10_000);
				try {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "verified\n" });
				} finally {
					clearTimeout(timeout);
					child.kill();
					await child.exited;
				}
			},
			15_000,
		);
	}
});
