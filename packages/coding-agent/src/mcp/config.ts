/**
 * MCP configuration loader.
 *
 * Uses the capability system to load MCP servers from multiple sources.
 */

import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { mcpCapability } from "../capability/mcp";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { readMCPConfigFile } from "./config-writer";
import type { MCPConfigFile, MCPServerConfig } from "./types";

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for each server */
	sources: Record<string, SourceMeta>;
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// Determine transport type
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		requestIdFormat: server.requestIdFormat,
		instructions: server.instructions,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.envPolicy) config.envPolicy = server.envPolicy;
		if (server.envLiteralKeys) config.envLiteralKeys = server.envLiteralKeys;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	// Fallback to stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/**
 * Load all MCP server configs from standard locations.
 * Uses the capability system for multi-source discovery.
 *
 * @param cwd Working directory (project root)
 * @param options Load options
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;

	// Load user-level disable/force-enable lists. The denylist always wins; the
	// allowlist overrides a non-writable source config's `enabled: false`.
	// A malformed or unreadable user mcp.json must not take down the whole MCP
	// stack (DOC.md#mcp-configuration-in-omp: the file simply contributes no entries): its
	// servers are already skipped by the mcp-json provider with a warning, so
	// the lists degrade to empty here instead of rejecting every source.
	const userPath = getMCPConfigPath("user", cwd);
	let userConfig: MCPConfigFile;
	try {
		const config: unknown = await readMCPConfigFile(userPath);
		// JSON.parse also accepts bare `null`, numbers, strings, and arrays;
		// only an object carries the server map and the lists read below.
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			throw new Error("user MCP config must be a JSON object");
		}
		userConfig = config as MCPConfigFile;
	} catch (error) {
		logger.warn("Ignoring unreadable user MCP config for server lists", { path: userPath, error: String(error) });
		userConfig = { mcpServers: {} };
	}
	const disabledServers = new Set(Array.isArray(userConfig.disabledServers) ? userConfig.disabledServers : []);
	const forcedEnabled = new Set(Array.isArray(userConfig.enabledServers) ? userConfig.enabledServers : []);

	// Scope exclusions drop entries entirely BEFORE deduplication: with project
	// config disabled, a project entry must not shadow anything.
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	// Disabled servers are suppressed rather than dropped: they still own their
	// name at key-level dedupe (a disabled project `foo` keeps a same-named,
	// lower-priority user `foo` disabled), but never equivalence-shadow a
	// differently-named enabled server — otherwise the disabled alias would be
	// removed downstream and starve the surviving connection.
	const suppressServer = (server: MCPServer & { _source: SourceMeta }): boolean => {
		if (disabledServers.has(server.name)) return true;
		if (server.enabled === false && !forcedEnabled.has(server.name)) return true;
		return false;
	};

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		extensionRoots: options?.extensionRoots,
		filter: includeServer,
		suppress: suppressServer,
	});

	// Discovery warnings (e.g. a Claude plugin manifest timeout below Claude
	// Code's 1000ms minimum) must reach the user, not vanish with the
	// CapabilityResult.
	for (const warning of result.warnings) logger.warn(warning);

	// Convert to legacy format and preserve source metadata.
	const configs: Record<string, MCPServerConfig> = {};
	const sources: Record<string, SourceMeta> = {};
	for (const server of result.items) {
		configs[server.name] = convertToLegacyConfig(server);
		sources[server.name] = server._source;
	}

	return { configs, sources };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}
