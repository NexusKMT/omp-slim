import { describe, expect, test } from "bun:test";
import { reloadConfigurationParams } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		command: "typescript-language-server",
		args: ["--stdio"],
		fileTypes: [".ts"],
		rootMarkers: ["package.json"],
		...overrides,
	};
}

describe("reloadConfigurationParams", () => {
	test("echoes the configured settings so a reload re-applies them", () => {
		const settings = { typescript: { preferences: { importModuleSpecifier: "relative" } } };
		expect(reloadConfigurationParams(serverConfig({ settings }))).toEqual({ settings });
	});

	test("matches the payload the initialize handshake pushes", () => {
		// client.ts sends `{ settings: config.settings ?? {} }` right after
		// `initialized`; reload must not disagree with the handshake.
		const config = serverConfig({ settings: { rust_analyzer: { check: { command: "clippy" } } } });
		expect(reloadConfigurationParams(config)).toEqual({ settings: config.settings });
	});

	test("falls back to an empty object when no settings are configured", () => {
		expect(reloadConfigurationParams(serverConfig())).toEqual({ settings: {} });
	});

	test("does not send an empty object when settings are configured (issue #8383)", () => {
		const params = reloadConfigurationParams(serverConfig({ settings: { biome: { enabled: true } } }));
		expect(params.settings).not.toEqual({});
		expect(Object.keys(params.settings)).toEqual(["biome"]);
	});

	test("preserves falsy and nested setting values verbatim", () => {
		const settings = { deno: { enable: false, lint: 0, unstable: [] as string[] } };
		expect(reloadConfigurationParams(serverConfig({ settings }))).toEqual({ settings });
	});

	test("passes the settings object through by reference without cloning", () => {
		const settings = { gopls: { buildFlags: ["-tags=integration"] } };
		expect(reloadConfigurationParams(serverConfig({ settings })).settings).toBe(settings);
	});
});
