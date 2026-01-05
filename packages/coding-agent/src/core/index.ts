/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session";
export { type BashExecutorOptions, type BashResult, executeBash } from "./bash-executor";
export type { CompactionResult } from "./compaction/index";
export {
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	type ExtensionUIContext,
	loadExtensionFromFactory,
	type ToolDefinition,
} from "./extensions/index";
export {
	createMCPManager,
	discoverAndLoadMCPTools,
	loadAllMCPConfigs,
	type MCPConfigFile,
	type MCPLoadResult,
	MCPManager,
	type MCPServerConfig,
	type MCPServerConnection,
	type MCPToolDefinition,
	type MCPToolDetails,
	type MCPToolsLoadResult,
	type MCPTransport,
} from "./mcp/index";

export * as utils from "./utils";
