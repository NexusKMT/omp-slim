import { resolveConfigValue } from "./config/resolve-config-value";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import {
	Agent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	Effort,
	Message,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

import { withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";

import type { Component } from "@oh-my-pi/pi-tui";
import { $env } from "@oh-my-pi/pi-utils/env";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import { AsyncJobManager, type AsyncJobManagerApi } from "./async";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability, reset as resetCapabilities } from "./capability";
import {
	MAIN_AGENT_RULE_NAME,
	type Rule,
	ruleCapability,
	setActiveRules,
	SUB_AGENT_RULE_NAME,
} from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import type { EffectiveExtensionRoots } from "./capability/types";

import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { ModelRegistry } from "./config/model-registry";
import {
	formatModelString,
	getModelMatchPreferences,
	pickDefaultAvailableModel,
	providerModelHint,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
	resolveSessionModelSelector,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { bindEffects, combine } from "./config/registry";
import { Settings } from "./config/settings";

import "./discovery";
import { LiveImageUrlService } from "./blob-broker/service";
import { wrapStreamFnWithBlobUrlFallback } from "./blob-broker/stream-fallback";
import { initializeWithSettings } from "./discovery";
import { setInvocationConfiguredExtensions, withOmpExtensionRootScope } from "./discovery/omp-extension-roots";
import { disposeVmContextsByOwner } from "./eval/js/context-manager";
import { getEnabledEvalPreludes, type EvalPreludeDefinition } from "./eval/preludes";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { createAnnotationsAPI } from "./extensibility/custom-commands/bundled/annotate/api";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	bindPreparedExtensions,
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	EXTENSION_HANDLER_TIMEOUT_MS,
	type ExtensionAgentIdentity,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	extensionToolSourceInfo,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type PreparedExtension,
	type RegisteredTool,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import type { UserWaitTracker } from "./extensibility/extensions/user-wait";
import { formatExtensionLoadNotifications } from "./extensibility/extensions/load-errors";
import { partitionStartupExtensions, recordStartupVerdicts } from "./extensibility/extensions/startup-deferral";
import {
	createSkillDescriptionCompressor,
	openSessionSkillDescriptionStore,
	SkillDescriptionCatalog,
} from "./extensibility/skill-descriptions";
import { resolvePath } from "./extensibility/utils";
import {
	type LoadSkillsOptions,
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import { LocalProtocolHandler, type LocalProtocolOptions, outRepliesActive } from "./internal-urls";
import { stripXdUrlPrefix } from "@oh-my-pi/pi-tui/tools/xd-url";
import { holdSharedLsp } from "./lsp/client";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	deduplicateMCPToolsByName,
	discoverAndLoadMCPTools,
	getMCPToolOriginKey,
	type MCPLoadResult,
	MCPManager,
	type MCPManagerApi,
	type MCPToolScope,
	MCPToolCache,
	type MCPToolsLoadResult,
} from "./mcp";
import { parseMCPToolName } from "@oh-my-pi/pi-tui/tools/mcp";
import { mapPromptArguments } from "./mcp/prompt-args";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { resolveMCPToolAlias } from "./mcp/tool-bridge";
import mcpXdevGuidanceTemplate from "./prompts/system/mcp-xdev-guidance.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type AgentKind,
	type AgentRef,
	AgentRegistry,
	type AgentRegistryApi,
	MAIN_AGENT_ID,
} from "./registry/agent-registry";
import {
	buildSecretObfuscator,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "./secrets";
import { AgentSession, MCP_DISCOVERY_TURN_WAIT_MS } from "./session/agent-session";
import type { AgentSessionDisposeOptions } from "./session/agent-session-types";

import { AuthStorage } from "./session/auth-storage";
import { CostCapError, type CostGateApi, guardStreamFn } from "./session/cost-gate";

import {
	createSessionDateCwdReminderJournal,
	type DateCwdReminderJournal,
	DateCwdReminderInjector,
} from "./session/date-cwd-reminder";
import { createInterruptedToolResults, createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import { recoverInlineSloppyEdit } from "./session/inline-edit-recovery";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
	dropUnreadableContextImages,
} from "./session/provider-image-budget";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import {
	collectMountedMCPToolRoutes,
	projectMountedMCPXdevGuidance,
	type SettingsGatedToolDelta,
	type SystemPromptRebuilder,
} from "./session/session-tools";

import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import { createSpeculativeToolExecutionConfig } from "./speculation/host";
import { closeAllConnections } from "./ssh/connection-manager";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	cfgSystemPromptInputs,
	composeAppendPrompt,
	loadProjectContextFiles as loadContextFilesInternal,
	projectSystemPromptToolMetadata,
	withoutAgentsMd,
} from "./system-prompt";
import type { AgentDefinition } from "./task/types";
import { AgentOutputManager } from "./task/output-manager";

import { isScoutSpawnable } from "./task/spawn-policy";
import { isMainThread } from "./thread/identity";
import type { StructuredSubagentSchemaMode } from "@oh-my-pi/pi-tui/tools/task";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	newSessionThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveConfiguredThinkingLevel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	createVibeTools,
	createXdevState,
	type DeferredDiagnosticsEntry,
	defaultLoadModeForToolName,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	HIDDEN_TOOLS,
	isMountableUnderXdev,
	type LspStartupServerInfo,
	listXdevTools,
	planXdevPromptDocs,
	ReadTool,
	renderXdevPromptDocs,
	resolveBuiltinToolPlan,
	resolveMountedXdevExecutable,
	SETTINGS_GATED_BUILTIN_TOOL_NAMES,
	supportsExternalThinking,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
	xdevEntries,
} from "./tools";
import { resolveYieldReportText } from "./tools/yield";
import {
	createModelJobCaptionWriter,
	createModelJobWidgetAuthor,
	type JobCaptionWriter,
	type JobWidgetAuthor,
	JobWidgets,
	type ModelJobWidgetAuthorOptions,
	resolveToolCallIntent,
} from "./job-widgets";
import { isMCPToolName, normalizeToolNames } from "./tools/builtin-names";
import { createRatchetPrelude } from "./ratchet/prelude-definition";
import { createArchivePrelude } from "./archive/prelude-definition";
import { ToolContextStore } from "./tools/context";
import { isIrcEnabled } from "./irc/messaging";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { isFilesystemSourcePath } from "./tools/path-utils";
import { isAutoQaEnabled } from "./tools/report-tool-issue";
import { queueResolveHandler } from "./tools/resolve";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { normalizeProviderContextImages } from "./utils/image-loading";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "./utils/prompt-path";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { VibeSessionRegistry } from "./vibe/runtime";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

import {
	cfgArchiveEnabled,
	cfgAsyncMaxJobs,
	cfgAsyncWidgets,
	cfgRatchetEnabled,
	cfgSecurityEnabled,
	cfgToolsIntentTracing,
	cfgToolsMaxTimeout,
	cfgToolsXdev,
	cfgToolsXdevDocs,
	cfgToolsXdevInlineDevices,
	cfgSessionToolGates,
} from "./tools/settings";

import {
	cfgDefaultThinkingLevel,
	cfgExternalThinking,
	cfgIncludeModelInPrompt,
	cfgIncludeWorkspaceTree,
	cfgInlineToolDescriptors,
	cfgPersonality,
	cfgProviderAppendOnlyContext,
	cfgSampling,
	cfgSkillful,
	cfgThinkingBudgets,
	cfgTierOpenai,
} from "./session/settings";
import { cfgInterruptMode } from "./modes/settings";
import { cfgFollowUpMode } from "./modes/settings";
import { cfgSteeringMode } from "./modes/settings";
import {
	cfgCommandsEnableClaudeProject,
	cfgCommandsEnableClaudeUser,
	cfgCommandsEnableOpencodeProject,
	cfgCommandsEnableOpencodeUser,
	cfgDisabledExtensions,
	cfgExtensions,
	cfgSkills,
	type SkillsSettings,
} from "./extensibility/settings";
import { cfgTtsr } from "./export/ttsr-settings";
import { cfgDisabledProviders, cfgEnabledModels, cfgEnabledProviders, cfgModel } from "./config/model-settings";
import { cfgEditRecoverInlineEdits } from "./edit/settings";
import { cfgGoalEnabled } from "./goals/settings";
import {
	cfgImagesBlockImages,
	cfgStartupQuiet,
	cfgTuiReactions,
	cfgTuiAutoGraph,
	cfgTuiRenderMermaid,
	cfgTuiRenderSvg,
} from "./modes/settings";
import { cfgLspEnabled, cfgLspLazy, cfgLspShared } from "./lsp/settings";
import {
	cfgMcpEnableProjectConfig,
	cfgMcpNotificationDebounceMs,
	cfgMcpNotifications,
	cfgMcpStartupTimeoutMs,
} from "./mcp/settings";
import { cfgPlanEnabled } from "./plan-mode/settings";
import { cfgSecretsEnabled } from "./secrets/settings";
import {
	cfgSnapcompactShape,
	cfgSnapcompactSystemPrompt,
	cfgSnapcompactToolResults,
	cfgWorkspaceAdditionalDirectories,
} from "./session/context-settings";
import {
	cfgTaskBatch,
	cfgTaskDisabledAgents,
	cfgTaskEager,
	cfgTaskMaxConcurrency,
	ovnfsCommand,
} from "./task/settings";

/** Agent-level tool-call switches, snapshotted by the agent loop per prompt run. */
const cfgToolCallSwitches = combine({
	intentTracing: cfgToolsIntentTracing,
});

/** Settings skill and file slash-command discovery reads (foreign sources gated by the provider lists). */
const cfgSkillsAndCommandsDiscovery = combine({
	skills: cfgSkills,
	commandsClaudeUser: cfgCommandsEnableClaudeUser,
	commandsClaudeProject: cfgCommandsEnableClaudeProject,
	commandsOpencodeUser: cfgCommandsEnableOpencodeUser,
	commandsOpencodeProject: cfgCommandsEnableOpencodeProject,
	enabledProviders: cfgEnabledProviders,
	disabledProviders: cfgDisabledProviders,
});

/** Settings deciding which configured extension sources a session loads. */
const cfgExtensionSources = combine({ extensions: cfgExtensions, disabledExtensions: cfgDisabledExtensions });

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(lateDiagnosticTemplate, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write",
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

function collectPendingMCPToolNames(explicitToolNames: readonly string[] | undefined): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute or cwd-relative. */
	additionalDirectories?: string[];
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;
	/** User-authorized model agents inherited from the parent session for nested delegation. */
	inheritedSessionAgents?: readonly AgentDefinition[];

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/** Request credential resolver. Defaults to the configured model registry resolver. */
	getApiKey?: AgentOptions["getApiKey"];

	/** Model to use. Default: from settings, else first available */
	model?: Model;

	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];

	/**
	 * Called with the model of every main-loop request before it is sent; throw to
	 * refuse it. Per-call `model` subagents use it so no switch reaches a model the
	 * operator did not approve.
	 */
	assertDispatchModel?: (model: Model) => void;

	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); retry-fallback recovery re-clamps to it. */
	thinkingLevelCeiling?: Effort;
	/** OpenAI service-tier override for this session. `null` omits `service_tier`. */
	openAIServiceTier?: ServiceTier | null;

	/**
	 * Per-family service tiers for this session, replacing the `tier.*` settings
	 * and any persisted tier history. Called once the initial model is final —
	 * after deferred `modelPattern` resolution and auth fallback — so the caller
	 * can scope a tier to that model's provider family. The result is always
	 * persisted, even when empty, so resume and cold revival restore it instead
	 * of re-deriving tiers from settings.
	 */
	resolveServiceTierByFamily?: (model: Model | undefined) => ServiceTierByFamily;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/**
	 * Session is IRC-routable before its owner sends the first prompt (task executor spawns): until
	 * then, incoming IRC messages queue for that prompt's turn instead of waking one without it.
	 */
	awaitingAssignment?: boolean;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: boolean;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Raw Handlebars template replacing the bundled default system prompt rendering. */
	systemPromptTemplate?: string;
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Task-derived cache candidate; applied only when the actual request model opts in. */
	taskPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;
	/** Cost gate of the parent session tree; without one the session starts its own from `session.warnCost` / `session.maxCost`. */
	costGate?: CostGateApi;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Live extension-root policy inherited by a child session. Keeps recursive
	 * sub-discovery aligned with the parent while `preloadedExtensionPaths` only
	 * optimizes extension-module loading.
	 *
	 * @internal
	 */
	extensionRoots?: () => EffectiveExtensionRoots;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedPreparedExtensions} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Extension sources whose binding waits until the session's first
	 * {@link AgentSession.loadDeferredExtensions} call (the CLI starts it once the
	 * composer accepts input; every submission and turn awaits it). They bind
	 * into the session runtime of {@link preloadedExtensions}, after it. Ignored
	 * for restricted-tool sessions.
	 *
	 * @internal
	 */
	deferredExtensionPaths?: readonly string[];
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * Compatibility pass-through for callers that do not have prepared factories.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Session-independent imported extension factories. Child sessions, including
	 * restricted children, rebind these to their own ExtensionAPI without
	 * re-evaluating the module graph. Restricted children retain hooks/providers,
	 * but never expose extension-contributed tools.
	 * @internal
	 */
	preloadedPreparedExtensions?: readonly PreparedExtension[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/**
	 * Root-scoped bus carrying `task:subagent:*` observability frames for this
	 * session and every subagent it spawns. Default: creates a new bus per
	 * root session; `buildSubagentSessionOptions` inherits the spawner's.
	 */
	subagentEventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Discover no context files: not from cwd (on start or a cwd change), not for additional workspace roots, and no nested AGENTS.md list. Explicit `contextFiles` still load. Inherited by subagents. */
	noContextFiles?: boolean;
	/** Drop every context file named `AGENTS.md`: from `contextFiles`, cwd discovery, and additional workspace roots. Set for task subagents. */
	excludeAgentsMd?: boolean;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/**
	 * Enable MCP capabilities. `false` skips MCP discovery and ignores
	 * `mcpManager`, preventing process-global or inherited MCP access. Default:
	 * true.
	 */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse when MCP is enabled (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManagerApi;
	/**
	 * MCP tools minted from a parent's shared manager (subagent proxies). They
	 * register as manager-owned MCP tools — active from the start and replaced
	 * wholesale by `refreshMCPTools` — so a parent `/mcp reload` can both add
	 * and remove them. Passed as `customTools` they would instead be retained as
	 * extension-owned tools across every refresh. A same-named `customTools`
	 * entry keeps precedence and drops the proxy. Ignored for restricted sessions.
	 */
	mcpTools?: CustomTool[];
	/** This session's view of {@link mcpManager} when it shares one it does not own (subagents); see `MCPManagerApi.getTools`. */
	mcpToolScope?: MCPToolScope;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Restrict LSP to navigation and diagnostics even when enabled. Defaults to true for restricted sessions. */
	lspReadOnly?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];
	/** Names from `toolNames` that a fork inherits as `xd://` devices rather than explicit top-level tools. */
	mountedToolNames?: string[];
	/** Limit the session to explicitly supplied tool names, without discovered extras. */
	restrictToolNames?: boolean;
	/**
	 * Permit only caller-supplied SDK custom tools inside a restricted session.
	 * They must still be named in {@link toolNames}; discovered extensions, MCP,
	 * and ambient custom tools remain disabled. Default: false.
	 */
	allowRestrictedCustomTools?: boolean;

	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/**
	 * Whether this top-level session takes over, until disposed, the process-global state that
	 * follows one settings instance: setting effects and capability provider toggles. Helper
	 * sessions a host session spawns on its behalf (security scan, agent-spec generation) pass
	 * `false`. Subagents (`parentTaskPrefix`/`taskDepth`) never bind. Default: true.
	 */
	bindProcessState?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/**
	 * Agent definition name used to evaluate rule `agents` scoping. Defaults to
	 * "main" for a top-level session / "sub" for a subagent.
	 */
	agentName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistryApi;
	/**
	 * Registry generation authorized for this creation. `null` requires the id
	 * to be absent; an AgentRef allows a parked revival to reuse only that ref.
	 * Undefined preserves legacy unconditional registration for external SDK callers.
	 * @internal
	 */
	expectedAgentRef?: AgentRef | null;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/** Parent's async jobs and delivery sinks; child sessions never resolve a process-global manager. */
	asyncJobManager?: AsyncJobManagerApi;
	/**
	 * Writes the specs of the root session's live job widgets. Defaults to the
	 * `widget` model role; tests inject a fake. Ignored for child sessions,
	 * which share their root's widgets.
	 */
	jobWidgetAuthor?: JobWidgetAuthor;
	/**
	 * Writes the captions of the root session's long command jobs. Defaults
	 * to the `widget` model role; ignored for child sessions, like
	 * {@link jobWidgetAuthor}.
	 */
	jobCaptionWriter?: JobCaptionWriter;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/** @deprecated Ignored. An unavailable saved model always makes restoration fail. */
	allowSessionModelFallback?: boolean;
	/**
	 * A human can answer synchronous prompts even without a terminal UI (e.g. an
	 * ACP client rendering elicitation forms). Enables `ask` without enabling
	 * TUI-only session behavior such as eager LSP warmup. An explicit `false` also
	 * keeps saved-reset consent off the extension UI context. Default: `hasUI`.
	 */
	interactivePrompts?: boolean;
	/** Keep `ask` advertised in a headless fork sharing a parent's tool-schema prefix; calls still fail without UI. */
	advertiseHeadlessAsk?: boolean;
	/**
	 * The user approves agent `cfg://` settings writes through the process-global
	 * host (`setCfgApprovalHost`). Only the top-level TUI session sets this; every
	 * other session gets no `cfg://` in its prompt and has writes refused. Default: false.
	 */
	settingsApproval?: boolean;
	/**
	 * Replies render in omp's own TUI transcript, which draws Mermaid, ```svg
	 * figures and table charts; only then does the system prompt mention them.
	 * Print, RPC, ACP and subagent sessions read replies as text. Default: false.
	 */
	tuiTranscript?: boolean;
	/**
	 * Name the unnamed session from the operator's messages once each reply begins
	 * (see `title.generator`). Only the interactive TUI sets this; ignored for subagents. Default: false.
	 */
	autoTitle?: boolean;
	/**
	 * Hold background skill-description compression until
	 * {@link AgentSession.startSkillDescriptionCompression}: resolving its model composes the
	 * whole model catalog. The interactive TUI sets this and starts it after the first frame.
	 * Default: false, which starts it once the session (and so its cost gate) exists.
	 */
	deferSkillDescriptionCompression?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;
}

/** Saved models were exhausted without permission to substitute another model. */
export class SessionModelRestoreError extends Error {
	constructor(modelSelector: string) {
		super(`Could not restore model ${modelSelector}`);
		this.name = "SessionModelRestoreError";
	}
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];

	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
	/** Root-scoped bus carrying this session tree's `task:subagent:*` frames. */
	subagentEventBus?: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings } from "./config/settings";
export type { SkillsSettings } from "./extensibility/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
// Agent registry: pass a private instance per `createAgentSession` when
// embedding several concurrent top-level sessions in one process (the default
// global registry admits only one "Main" per process generation).
export { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	HIDDEN_TOOLS,
	ReadTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

/** Open the local API-key store without remote credential brokers or provider discovery. */
export function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return AuthStorage.create(getAgentDbPath(agentDir), { configValueResolver: resolveConfigValue });
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

type ExtensionDiscoveryOptions = Pick<
	CreateAgentSessionOptions,
	"disableExtensionDiscovery" | "additionalExtensionPaths" | "extensionRoots"
> & { includeAmbientHooks?: boolean };

type CliExtensionProviderOptions = ExtensionDiscoveryOptions & {
	/** Discover extension model catalogs after registration (default true); usage-only commands skip it. */
	discoverModels?: boolean;
};

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const roots = options.extensionRoots?.();
	const explicit = roots?.explicit ?? options.additionalExtensionPaths ?? [];
	const explicitOnly = roots ? roots.mode === "explicit-only" : options.disableExtensionDiscovery;
	const configuredPaths = explicitOnly
		? [...explicit]
		: [...explicit, ...(roots?.configured ?? cfgExtensions.get(settings))];
	const disabledExtensionIds = explicitOnly ? undefined : cfgDisabledExtensions.get(settings);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !explicitOnly,
		includeAmbientHooks: options.includeAmbientHooks,
	});
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 *
 * With `deferStartupSafe`, sources whose recorded startup verdict proves they
 * register nothing needed before the first frame are left unloaded and
 * returned as `deferredPaths` for {@link CreateAgentSessionOptions.deferredExtensionPaths}.
 */
export async function loadSessionExtensions(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	loadOptions: { deferStartupSafe?: boolean } = {},
): Promise<LoadExtensionsResult & { deferredPaths: string[] }> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const storage = settings.getStorage();
	const { eager, deferred } =
		loadOptions.deferStartupSafe && storage
			? await partitionStartupExtensions(storage, paths, cwd)
			: { eager: paths, deferred: [] };
	const result = await logger.time("loadExtensions", loadExtensions, eager, cwd, eventBus);
	if (storage) await recordStartupVerdicts(storage, result.extensions);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return { ...result, deferredPaths: deferred };
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`omp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.omp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `omp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved, unless `discoverModels: false` (e.g. `omp usage`,
 * which needs only registered usage providers).
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: CliExtensionProviderOptions = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	modelRegistry.clearSourceRegistrations(new Set(activeSources));
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings & Pick<LoadSkillsOptions, "disabledExtensions">,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
	disabledExtensions?: string[],
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		disabledExtensions,
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	/** Raw Handlebars template replacing the bundled default system prompt rendering. */
	systemPromptTemplate?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
	/** Include the read-only security:// resource inventory entry. Default: false. */
	securityEnabled?: boolean;
	/** Eval preludes to advertise; each contributes its `guidance` block. Default: none. */
	evalPreludes?: readonly Pick<EvalPreludeDefinition, "name" | "guidance">[];
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolNames = options.tools?.map(tool => tool.name);
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	const promptTools = toolMap
		? projectSystemPromptToolMetadata(
				toolMap,
				options.inlineToolDescriptors ? { mode: "full" } : { mode: "compact", toolNames: toolNames ?? [] },
			)
		: undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		systemPromptTemplate: options.systemPromptTemplate,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		securityEnabled: options.securityEnabled,
		evalPreludes: options.evalPreludes,
		toolNames,
		tools: promptTools,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__ompLegacyBuiltinTool" in tool && tool.__ompLegacyBuiltinTool === true;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");
/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;
/** Built-ins `createTools` force-includes into explicit tool lists; the active set mirrors them. */
const SESSION_MANAGED_BUILTIN_TOOL_NAMES = ["context_notes", "new_context"];

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	try {
		await closeAllConnections();
	} catch (error) {
		logger.warn("SSH cleanup failed", { error: String(error) });
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

export function customToolToDefinition(tool: CustomTool, sourcePath?: string): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		defaultInactive: tool.hidden === true,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,
		readsSkillUris: tool.readsSkillUris,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		// Extension tools take part in Ask-and-remember grants through the same bridge.
		approvalCacheTargets:
			typeof tool.approvalCacheTargets === "function"
				? tool.approvalCacheTargets.bind(tool)
				: tool.approvalCacheTargets,
		// Preserved through RegisteredToolAdapter so MCP-backed tools' explicit
		// `strict: false` (#4336/#4340) survives the custom-tool → definition bridge.
		strict: tool.strict,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		mcpReadOnlyHint: tool.mcpReadOnlyHint,
		// Forwarded so MCP tools renamed by the digit-keeping mint keep honoring
		// legacy `deny`/`prompt` policies; RegisteredToolAdapter re-exposes it.
		legacyName: tool.legacyName,
		sourcePath,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[], sourcePaths?: ReadonlyMap<string, string>): ExtensionFactory {
	const uniqueTools = deduplicateMCPToolsByName(tools);
	return api => {
		for (const tool of uniqueTools) {
			api.registerTool(customToolToDefinition(tool, sourcePaths?.get(tool.name)));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of uniqueTools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					retryErrors: event.retryErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs = mapPromptArguments(prompt.arguments, args);
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const extensionRoots = options.extensionRoots?.();
	const explicit = extensionRoots?.explicit ?? options.additionalExtensionPaths ?? [];
	const mode = extensionRoots?.mode ?? (options.disableExtensionDiscovery ? "explicit-only" : "merge");
	return await withOmpExtensionRootScope(explicit, mode, () => createAgentSessionScoped(options));
}

async function createAgentSessionScoped(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	if (options.systemPromptTemplate !== undefined && options.customSystemPrompt !== undefined) {
		throw new Error("systemPromptTemplate cannot be combined with a literal custom system prompt");
	}
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();
	const subagentEventBus = options.subagentEventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	// Discovery provider toggles and process-wide setting effects (theme, request limits, …)
	// follow the newest holder: each top-level session holds both on its settings until disposed,
	// then hands them back to the previous holder. Subagents and helper sessions never take them,
	// so a parent's live edits keep reaching discovery and effects.
	const bindsProcessState = options.bindProcessState !== false && !options.parentTaskPrefix && !options.taskDepth;
	const restoreProviderToggles = bindsProcessState
		? logger.time("initializeWithSettings", initializeWithSettings, settings)
		: undefined;
	const unbindSessionEffects = bindsProcessState ? bindEffects(settings) : undefined;
	// Until the session is handed back (its dispose wrapper then owns the process-state holds
	// and the credential listener), any startup failure below releases them.
	using startupCleanup = new DisposableStack();
	if (restoreProviderToggles) startupCleanup.defer(restoreProviderToggles);
	if (unbindSessionEffects) startupCleanup.defer(unbindSessionEffects);
	// Snapshot this session's effective configured lane onto its invocation scope
	// so startup sub-discovery sees the same complete policy that post-startup
	// reloads and recursively spawned children consume.
	const extensionRoots = options.extensionRoots?.();
	setInvocationConfiguredExtensions(
		extensionRoots?.configured ?? cfgExtensions.get(settings),
		extensionRoots?.configuredLevel ?? settings.extensionsSourceLevel(),
	);

	// Every session subsystem uses the registry-owned API-key store.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(
			options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)),
			path.join(agentDir, "models.yml"),
			{
				settings,
			},
		);
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}

	// Kick off workspace tree discovery early. The native workspace scan returns
	// both the rendered-tree input and the AGENTS.md directory-context index, so
	// startup does not perform a second recursive filesystem search. Subagents
	// inherit the parent's resolved values via options.
	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const emptyWorkspaceTree: WorkspaceTree = {
		rootPath: cwd,
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	};
	const scanWorkspaceTree = (): Promise<WorkspaceTree> => {
		const scan = logger.time("buildWorkspaceTree", () =>
			buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }),
		);
		scan.catch(() => {});
		return scan;
	};
	// Undefined until needed: enabling `includeWorkspaceTree` mid-session scans
	// on the next prompt rebuild (see rebuildSystemPrompt).
	let workspaceTreePromise: Promise<WorkspaceTree> | undefined = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: cfgIncludeWorkspaceTree.get(settings)
			? scanWorkspaceTree()
			: undefined;
	// Tree from a mid-session scan; supersedes the startup value handed to subagents.
	let lateWorkspaceTree: WorkspaceTree | undefined;

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const excludeAgentsMd = options.excludeAgentsMd === true;
	const contextFileFilter = <T extends { path: string }>(files: T[]): T[] =>
		excludeAgentsMd ? withoutAgentsMd(files) : files;
	const pinnedContextFiles = options.contextFiles
		? contextFileFilter(options.contextFiles)
		: options.noContextFiles
			? []
			: undefined;
	const contextFilesPromise = pinnedContextFiles
		? Promise.resolve(pinnedContextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir).then(contextFileFilter);
	contextFilesPromise.catch(() => {});
	const resolveRepoContext = async (repoCwd: string) => {
		try {
			return await resolveActiveRepoContext(repoCwd);
		} catch (err) {
			logger.debug("Failed to resolve active repo context", { err: String(err) });
			return null;
		}
	};
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", resolveRepoContext, cwd);
	activeRepoContextPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const advisorConfigsPromise = logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir));
	advisorConfigsPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const customCommandsPromise =
		options.disableExtensionDiscovery || options.restrictToolNames === true
			? Promise.resolve<CustomCommandsLoadResult>({ commands: [], errors: [] })
			: logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
	customCommandsPromise.catch(() => {});
	const skillsSettings = cfgSkills.get(settings);
	const disabledExtensionIds = cfgDisabledExtensions.get(settings);
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const configuredDirs = options.additionalDirectories
		? options.additionalDirectories
		: cfgWorkspaceAdditionalDirectories.get(settings);
	if (configuredDirs.length > 0) {
		// Merge with any roots restored from the session header (resume/fork), not replace.
		const existing = sessionManager.getAdditionalDirectories();
		const merged = [...new Set([...existing, ...configuredDirs])];
		await sessionManager.setAdditionalDirectories(merged);
	}
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const taskPromptCacheKey = options.taskPromptCacheKey ?? sessionManager.getHeader()?.taskPromptCacheKey;
	if (taskPromptCacheKey !== undefined) await sessionManager.setTaskPromptCacheKey(taskPromptCacheKey);

	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.systemPromptTemplate !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined ||
		options.mcpTools !== undefined;
	const inheritedPromptCacheKey =
		forkCacheShapeChanged || taskPromptCacheKey !== undefined
			? undefined
			: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey =
		taskPromptCacheKey !== undefined && options.providerPromptCacheKeySource === "fork"
			? undefined
			: (options.providerPromptCacheKey ?? inheritedPromptCacheKey);
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;
	// Selection reads configured auth metadata; keys resolve only when a request is sent.
	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	// Load and create secret obfuscator early so resumed session state and prompt warnings
	// reflect actual loaded secrets, not just the setting toggle. Reassigned when
	// `secrets.enabled` first turns on mid-session (see the watch after session creation).
	let obfuscator: SecretObfuscator | undefined = cfgSecretsEnabled.get(settings)
		? await buildSecretObfuscator(cwd, agentDir, options.agentDir)
		: undefined;

	// An abnormal process exit after a non-terminal message tail is durable
	// evidence that the old process can no longer finish that turn. Preserve the
	// partial transcript and append one terminal aborted assistant record before
	// rebuilding runtime context. The helper is idempotent once that record exists.
	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		for (const result of createInterruptedToolResults(existingBranch)) sessionManager.appendMessage(result);
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	let existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const defaultRoleValue = settings.getModelRole("default");
	let explicitDefaultProviders: Set<string> | undefined;
	if ((cfgEnabledModels.get(settings)?.length ?? 0) === 0) {
		const patterns = resolveConfiguredModelPatterns(defaultRoleValue, settings);
		if (patterns && patterns.length > 0) {
			const providers = new Set<string>();
			for (const pattern of patterns) {
				const slash = pattern.indexOf("/");
				const provider = slash > 0 ? pattern.slice(0, slash).trim() : "";
				if (!provider || /[*?[\]{}]/.test(provider)) {
					providers.clear();
					break;
				}
				providers.add(provider);
			}
			if (providers.size > 0) explicitDefaultProviders = providers;
		}
	}

	const allowedModels = await logger.time("resolveAllowedModels", () =>
		explicitDefaultProviders
			? modelRegistry.getAvailableForProviders(explicitDefaultProviders)
			: resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(defaultRoleValue, allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	// Identify session model strings to restore in fallback order. We do an
	// initial pass here so model-dependent setup (thinking-level resolution,
	// host preconnect) can use the restored model; extension-registered
	// providers aren't visible yet, so we retry the preferred candidates once
	// extensions register below.
	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole()).slice(0, 1)
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const restored = resolveSessionModelSelector(modelRegistry, sessionModelStr);
				if (restored) {
					model = restored.model;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = restored.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && sessionModelStrings.length === 0 && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	// Resolves the session/agent thinking level using the same precedence we
	// apply at startup: explicit option → persisted session entry → restored
	// model selector suffix → default role's explicit selector → selected
	// model's defaultLevel → global settings default. A global `auto` is always
	// an explicit user choice (the setting defaults to a concrete level), so it
	// outranks the model's defaultLevel. Run again after extension role reclaim
	// so the final model's own defaults aren't masked by an earlier fallback
	// model's.
	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
		let level = options.thinkingLevel;
		if (level === undefined && hasExistingSession && hasThinkingEntry) {
			level =
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel);
		}
		if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			level = restoredSessionThinkingLevel;
		}
		if (level !== undefined) return level;
		const roleLevel =
			!hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel
				? defaultRoleSpec.thinkingLevel
				: undefined;
		return newSessionThinkingLevel(
			selectedModel,
			roleLevel,
			parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings)),
		);
	};
	let thinkingLevel = pickInitialThinkingLevel(model);
	let autoThinking = thinkingLevel === AUTO_THINKING;
	// Concrete level the agent/session start with. With `auto` this is the
	// provisional level shown until the first per-turn classification resolves;
	// `auto` itself stays a session-only concept handled by AgentSession.
	let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			resolveConfiguredThinkingLevel(resolvedModel, thinkingLevel),
		);
	}

	// Re-derives the thinking level whenever startup settles on a different
	// model than the one (possibly none) the level above was resolved against,
	// so the settings default is clamped to the model's actual effort ladder.
	const adoptThinkingForModel = (selectedModel: Model): void => {
		thinkingLevel = pickInitialThinkingLevel(selectedModel);
		autoThinking = thinkingLevel === AUTO_THINKING;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			resolveConfiguredThinkingLevel(selectedModel, thinkingLevel),
		);
	};

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Agent identity must resolve before rule discovery: `agents` frontmatter decides
	// which rules are bucketed into this session at all.
	const isSubagentSession = (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
	const agentKind: AgentKind = isSubagentSession ? SUB_AGENT_RULE_NAME : MAIN_AGENT_RULE_NAME;
	// Visuals (Mermaid, SVG figures, table charts) are drawn only in the top-level TUI transcript.
	const tuiTranscript = options.tuiTranscript === true && !isSubagentSession;
	const resolvedAgentName = (options.agentName ?? agentKind).trim().toLowerCase();

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const discovered = await logger.time("discoverTtsrRules", async () => {
		const { TtsrManager } = await import("./export/ttsr");
		const ttsrSettings = cfgTtsr.get(settings);
		// Live source: enable/repeat/interrupt/context changes apply on the next check.
		const ttsrManager = new TtsrManager(() => cfgTtsr.get(settings));
		const rulesResult =
			options.rules !== undefined
				? { items: options.rules, warnings: undefined }
				: await loadCapability<Rule>(ruleCapability.id, { cwd, agentDir });
		const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
			builtinRules: ttsrSettings.builtinRules,
			disabledRules: ttsrSettings.disabledRules,
			agentName: resolvedAgentName,
		});
		if (existingSession.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
		}
		return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
	});
	const { ttsrManager, allRules } = discovered;
	// Mutable so the mid-session prompt rebuild (on /clear and /new) can re-discover
	// rules from disk, mirroring the context-file refresh below (issue #10940). The
	// same `ttsrManager` is reused, so restored TTSR injection state survives.
	let rulebookRules = discovered.rulebookRules;
	let alwaysApplyRules = discovered.alwaysApplyRules;

	// Resolve contextFiles up-front (it's needed before tool creation). The
	// workspace tree scan is slow on large repos and we MUST NOT block startup on
	// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
	// will re-race the same promise through its own withDeadline path. Background
	// work continues so caches still warm.
	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const deadline = Promise.withResolvers<undefined>();
		// Cleared once the race settles: a pending timer would keep this whole startup
		// scope (settings, session, registries) reachable for the full deadline.
		const timer = setTimeout(() => {
			timedOut = true;
			deadline.resolve(undefined);
		}, STARTUP_SCAN_DEADLINE_MS);
		let result: T | undefined;
		try {
			result = await Promise.race([work, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};
	const [initialContextFiles, resolvedWorkspaceTree, watchdogFiles, initialActiveRepoContext, discoveredAdvisors] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise ?? Promise.resolve(emptyWorkspaceTree)),
			watchdogFilesPromise,
			activeRepoContextPromise,
			advisorConfigsPromise,
		]);
	let contextFiles = initialContextFiles;

	let agent: Agent;
	const effectiveGetApiKey =
		options.getApiKey ?? (requestModel => modelRegistry.resolver(requestModel, agent.sessionId));
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	const restrictToolNames = options.restrictToolNames === true;
	// The session tree shares one cost gate: a subagent is given its parent's; a root
	// session owns one that follows its session file. Read it per request, so a request
	// lands on the gate of the session file it was sent for.
	const currentCostGate = (): CostGateApi | undefined => session?.costGate ?? options.costGate;
	const enableLsp = options.enableLsp ?? !restrictToolNames;
	const lspReadOnly = options.lspReadOnly ?? restrictToolNames;
	// Every root owns its jobs and delivery sinks, even when another root is live.
	// Children use the exact manager passed by their parent; the singleton remains
	// only a legacy pointer to whichever root first installed it, never a routing fallback.
	const asyncJobManager = !options.parentTaskPrefix
		? new AsyncJobManager({
				maxRunningJobs: () => Math.min(100, cfgAsyncMaxJobs.get(settings)),
			})
		: undefined;
	if (asyncJobManager) {
		const usagePurpose =
			(purpose: string): ModelJobWidgetAuthorOptions["onUsage"] =>
			message => {
				if (!message.usage) return;
				sessionManager.appendModelUsage(
					{
						purpose,
						api: message.api,
						provider: message.provider,
						model: message.model,
						usage: message.usage,
						stopReason: message.stopReason,
					},
					{ sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() },
				);
			};
		const cheapModelOptions: Omit<ModelJobWidgetAuthorOptions, "onUsage"> = {
			getModel: () => agent?.state.model,
			settings,
			modelRegistry,
			sessionId: () => sessionManager.getSessionId(),
			costGate: currentCostGate,
			telemetry: () => agent?.telemetry,
			obfuscate: () => (obfuscator?.hasSecrets() ? text => obfuscator?.obfuscate(text) ?? text : undefined),
		};
		asyncJobManager.widgets = new JobWidgets({
			enabled: () => cfgAsyncWidgets.get(settings),
			author:
				options.jobWidgetAuthor ??
				createModelJobWidgetAuthor({ ...cheapModelOptions, onUsage: usagePurpose("job-widget") }),
			captioner:
				options.jobCaptionWriter ??
				createModelJobCaptionWriter({ ...cheapModelOptions, onUsage: usagePurpose("job-caption") }),
		});
	}
	const scopedAsyncJobManager = asyncJobManager ?? options.asyncJobManager;

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName = options.agentDisplayName ?? agentKind;
	let registeredAgentRef: AgentRef | undefined;
	/**
	 * Forget the agent ref on teardown — unless it is a retained terminal ref.
	 * Parking disposes the session but keeps the ref addressable (history://,
	 * revive); a hard kill leaves it as a terminal `aborted` tombstone. Both are
	 * detached (session === null) by the time dispose runs, per the AgentRef
	 * invariant, so preserving them never keeps a disposed session reachable — an
	 * aborted ref that still holds a live session is a bug and is unregistered
	 * rather than handed to ensureLive. Only process teardown / a plain release
	 * unregisters.
	 */
	const unregisterUnlessParked = (): void => {
		const ref = registeredAgentRef;
		if (!ref || agentRegistry.get(resolvedAgentId) !== ref) return;
		if (ref.status === "parked" || (ref.status === "aborted" && !ref.session)) return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId, ref)) return;
		agentRegistry.unregister(resolvedAgentId, ref);
	};
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		// Per-path mutation counter shared across edit/write tools. Late-diagnostics
		// entries capture it at fetch time and are dropped at injection if a newer
		// mutation (any tool) bumped it in the meantime.
		const fileMutationVersions = new Map<string, number>();
		const disposeCallbacks = new Set<() => void>();
		const activeToolNames = new Set<string>();
		const toolRegistry = new Map<string, Tool & Pick<ToolDefinition, "defaultInactive">>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			get costGate() {
				return currentCostGate();
			},
			isToolActive: name => activeToolNames.has(name),
			setActiveToolNames,
			toolRegistry,
			hasUI: options.hasUI ?? false,
			canPromptUser: options.interactivePrompts ?? options.hasUI ?? false,
			advertiseHeadlessAsk: options.advertiseHeadlessAsk,
			settingsApproval: options.settingsApproval === true && !isSubagentSession,
			tuiTranscript,
			// Explicit resolvers retain their existing pass-through contract. Ordinary
			// sessions inherit stored affinity into the child's own provider session.
			getApiKey: options.getApiKey,
			getCredentialSourceSessionId: options.getApiKey ? undefined : () => agent.sessionId,
			get additionalDirectories() {
				return sessionManager.getAdditionalDirectories();
			},
			enableLsp,
			lspReadOnly,
			enableIrc: restrictToolNames ? false : options.enableIrc,
			/**
			 * Frozen at the last system-prompt rebuild: a mid-session `/skillful`
			 * toggle rides the next turn's notice, never the tool prefix. The
			 * snapshot belongs to `SessionTools` (owner of the rebuild lifecycle);
			 * before SessionTools exists this defaults to the startup settings.
			 */
			get skillHintVisible() {
				return (
					session?.getSkillHintVisible() ??
					(cfgSkillful.get(settings) === true && (session?.skills ?? skills).length > 0)
				);
			},
			restrictToolNames,
			get seanceSourceArtifactsDir() {
				return sessionManager.getSeanceSourceArtifactsDir() ?? undefined;
			},
			get hasEditTool() {
				const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
				return restrictToolNames
					? requestedToolNames?.includes("edit") === true
					: !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			noContextFiles: options.noContextFiles,
			get workspaceTree() {
				return lateWorkspaceTree ?? resolvedWorkspaceTree;
			},
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.reloadSkills(),
			skillRediscoveryHost: () => session.skillRediscoveryHost(),
			rules: allRules,
			activeRules: [...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()],
			eventBus,
			subagentEventBus,
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			sessionManager,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () => session?.getEvalSessionId() ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			isDisposed: () => session?.isDisposed ?? false,
			getAgentId: () => resolvedAgentId,
			getPromptCacheKey: () => {
				if (!session) return undefined;
				const model = session.agent.state.model;
				if (!model) return undefined;
				return session.getPromptCacheKeyForModel(model) ?? session.agent.sessionId;
			},
			getToolByName: name => session?.getToolByName(name),
			getToolForEvalBridge: name => session?.getToolForEvalBridge(name),
			getAdvertisedEvalToolNames: () => session?.getAdvertisedEvalToolNames() ?? [],
			agentRegistry,
			// The global lifecycle releases through AgentRegistry.global(); wiring it
			// onto a caller-supplied registry would report a cancel while releasing an
			// unrelated global ref. With no lifecycle, explicit cancellation falls back to
			// dispose + unregister on the session's own registry.
			agentLifecycle: options.agentRegistry ? undefined : () => AgentLifecycleManager.global(),
			getSessionSpawns: () => options.spawns ?? "*",
			getSessionAgents: () => session?.getSessionAgents() ?? [],
			advertisedSessionAgents: () => session?.getAdvertisedSessionAgents() ?? [],
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModel: () => agent?.state.model ?? model,
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getPlanModeState: () => session?.getPlanModeState(),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? "local://PLAN.md",
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			emitBeforeSubagentSpawn: (event, signal) =>
				session?.extensionRunner?.emitBeforeSubagentSpawn(event, signal) ?? Promise.resolve(undefined),
			queueDeferredDiagnostics: entry => session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			registerDisposeCallback: callback => {
				disposeCallbacks.add(callback);
				return () => disposeCallbacks.delete(callback);
			},
			registerSessionChangeCallback: callback => session?.registerSessionChangeCallback(callback),
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			commitTodoPhases: phases => session.commitTodoPhases(phases),
			getWorkPoolYieldItems: () => session?.getWorkPoolYieldItems() ?? [],
			getLastAssistantText: () => session?.getLastAssistantText(),
			getYieldReportText: toolCallId => resolveYieldReportText(session?.messages ?? [], toolCallId),
			getToolCallIntent: toolCallId => resolveToolCallIntent(session?.messages ?? [], toolCallId),
			setWorkPoolYieldItems: items => session.setWorkPoolYieldItems(items),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekPlanProposalHandler: () => session.peekPlanProposalHandler(),
			setPlanProposalHandler: handler => session.setPlanProposalHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Tools and nested subagents use this root's manager, never another root's singleton.
			asyncJobManager: scopedAsyncJobManager,
		};
		let ratchetPrelude: EvalPreludeDefinition | undefined;
		let archivePrelude: EvalPreludeDefinition | undefined;
		const getEvalPreludes = (): readonly EvalPreludeDefinition[] => {
			if (restrictToolNames || !toolRegistry.has("eval") || !activeToolNames.has("eval")) return [];
			const builtins: EvalPreludeDefinition[] = [];
			if (cfgRatchetEnabled.get(settings)) {
				ratchetPrelude ??= createRatchetPrelude(toolSession);
				builtins.push(ratchetPrelude);
			}
			if (cfgArchiveEnabled.get(settings)) {
				archivePrelude ??= createArchivePrelude(toolSession);
				builtins.push(archivePrelude);
			}
			return getEnabledEvalPreludes(builtins);
		};
		toolSession.getEvalPreludes = getEvalPreludes;
		// SessionTools owns the advertised snapshot; before it exists the base
		// prompt is built from, and therefore advertises, the live set.
		toolSession.getAdvertisedEvalPreludes = () => session?.getAdvertisedEvalPreludes() ?? getEvalPreludes();

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager && !AsyncJobManager.instance()) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions && !options.parentTaskPrefix) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Restricted sessions cannot inherit or discover MCP capabilities.
		const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
		let mcpManager: MCPManagerApi | undefined = enableMCP ? options.mcpManager : undefined;
		// A subagent worker thread never connects MCP servers itself: it reuses the main thread's manager.
		if (enableMCP && !mcpManager && !isMainThread()) mcpManager = MCPManager.instance();
		/** Manager this session created by running discovery (it owns its callbacks); unset when reused. */
		let ownedMcpManager: MCPManager | undefined;
		toolSession.mcpManager = mcpManager;
		toolSession.mcpToolScope = options.mcpToolScope;
		toolSession.enableMCP = enableMCP;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		const initialMcpManagerTools: CustomTool[] = [];
		let startDeferredMCPDiscovery: ((liveSession: AgentSession) => void) | undefined;
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || cfgStartupQuiet.get(settings)) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		// Provider, never a stored value: inherited child policy remains linked to
		// the owning session, while top-level sessions materialize their own live
		// settings on every discovery call.
		const buildSessionExtensionRoots =
			options.extensionRoots ??
			((): EffectiveExtensionRoots => ({
				explicit: options.additionalExtensionPaths ?? [],
				mode: options.disableExtensionDiscovery ? "explicit-only" : "merge",
				configured: cfgExtensions.get(settings),
				configuredLevel: settings.extensionsSourceLevel(),
			}));
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			startupTimeoutMs: cfgMcpStartupTimeoutMs.get(settings),
			enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
			// Always filter Exa - we have native integration
			filterExa: true,
			extensionRoots: buildSessionExtensionRoots(),
		};
		if (enableMCP && !mcpManager && isMainThread()) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				const deferredMCPManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				ownedMcpManager = deferredMCPManager;
				mcpManager = deferredMCPManager;
				deferredMCPManager.setAuthStorage(authStorage);
				toolSession.mcpManager = deferredMCPManager;

				if (cfgMcpNotifications.get(settings)) {
					deferredMCPManager.setNotificationsEnabled(true);
				}
				startDeferredMCPDiscovery = liveSession => {
					const discovery = (async () => {
						try {
							const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
								deferredMCPManager.discoverAndConnect({
									...mcpDiscoverOptions,
									enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
								}),
							);
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
							// Connected MCP tools (and cached routes of servers still connecting) are
							// enabled and mounted under xd:// devices right away, so a turn whose
							// wait runs out still carries them.
							await liveSession.refreshMCPTools(mcpResult.tools);
							// Discovery returns after the startup window while slower servers keep
							// connecting. Give them the first turn's wait budget, then publish the
							// final snapshot so that turn's prompt carries their instructions too.
							await deferredMCPManager.waitForStartup(MCP_DISCOVERY_TURN_WAIT_MS);
							if (liveSession.isDisposed) return;
							await liveSession.refreshMCPTools(deferredMCPManager.getTools());
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
					liveSession.setPendingMCPDiscovery(discovery);
				};
			} else {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
					...mcpDiscoverOptions,
					cacheStorage: settings.getStorage(),
					authStorage,
				});
				const discoveredMCPManager = mcpResult.manager;
				ownedMcpManager = discoveredMCPManager;
				mcpManager = discoveredMCPManager;
				toolSession.mcpManager = discoveredMCPManager;

				if (cfgMcpNotifications.get(settings)) {
					discoveredMCPManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				// Log MCP errors
				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				// MCP tools are LoadedCustomTool, extract the tool property while
				// retaining their origins for initial registry ownership.
				const loadedMcpTools = mcpResult.tools.map(loaded => loaded.tool);
				customTools.push(...loadedMcpTools);
				initialMcpManagerTools.push(...loadedMcpTools);
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager instanceof MCPManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		const builtInToolNames = [...toolRegistry.keys()];
		let customToolPaths: ToolPathWithSource[] = [];
		const inlineExtensions: ExtensionFactory[] = [];
		if (!restrictToolNames) {
			// Discover custom tools from `.omp/tools/`, `.claude/tools/`, plugins, etc.
			// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
			// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
			// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
			// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
			// execution back through the parent — wrong for isolated tasks and for
			// pending-action queueing.
			customToolPaths =
				options.preloadedCustomToolPaths ??
				(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd, agentDir)));
			const customToolsLoadResult = await logger.time("loadCustomTools", () =>
				loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
			);
			for (const { path, error } of customToolsLoadResult.errors) {
				logger.error("Custom tool load failed", { path, error });
			}
			const customToolSourcePaths = new Map<string, string>();
			if (customToolsLoadResult.tools.length > 0) {
				for (const loaded of customToolsLoadResult.tools) {
					customTools.push(loaded.tool);
					if (isFilesystemSourcePath(loaded.resolvedPath)) {
						customToolSourcePaths.set(loaded.tool.name, loaded.resolvedPath);
					}
				}
			}

			inlineExtensions.push(...(options.extensions ?? []));
			inlineExtensions.push(createAutoresearchExtension);
			if (customTools.length > 0) {
				inlineExtensions.push(createCustomToolsExtension(customTools, customToolSourcePaths));
			}
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		// Load extensions. Four paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedPreparedExtensions` (subagent): caller imported modules;
		//      re-bind their factories to THIS session's ExtensionAPI without
		//      evaluating the same module graph again.
		//   3. `preloadedExtensionPaths`: compatibility fallback for callers that
		//      only have paths; imports and binds them for this session.
		//   4. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (!restrictToolNames && options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
				preparedExtensions: options.preloadedExtensions.preparedExtensions?.slice(),
			};
			// Capture paths for downstream forwarding; filter inline-factory
			// entries (`<inline-N>`) — those are per-session, not source paths.
			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
		} else if (restrictToolNames || options.preloadedPreparedExtensions) {
			// Restricted children retain parent hooks, not ambient discovery, new
			// extension inputs, or parent-bound instances. Tool admission stays clamped.
			const preparedExtensions = options.preloadedPreparedExtensions ?? [];
			extensionPaths = preparedExtensions.map(prepared => prepared.path);
			extensionsResult = await logger.time(
				"bindPreparedExtensions",
				bindPreparedExtensions,
				preparedExtensions,
				cwd,
				eventBus,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to bind extension", { path, error });
			}
		} else if (options.preloadedExtensionPaths) {
			extensionPaths = options.preloadedExtensionPaths;
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, settings),
			);
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;
		toolSession.effectiveExtensionRoots = buildSessionExtensionRoots;

		// Inline source ids must remain stable when caller factories are rebound in
		// child sessions. Start after any prepared inline sources so SDK-provided
		// factories (autoresearch/custom tools) keep the same ids as the parent.
		let nextInlineExtensionIndex = 0;
		for (const extension of extensionsResult.extensions) {
			const match = /^<inline-(\d+)>$/.exec(extension.path);
			if (match) {
				nextInlineExtensionIndex = Math.max(nextInlineExtensionIndex, Number(match[1]) + 1);
			}
		}

		// Load inline extensions from factories. Caller-provided factories are safe
		// to rebind, so preserve them with file-backed prepared extensions for
		// `/tan` and other child sessions.
		const rebindableInlineExtensionCount = options.extensions?.length ?? 0;
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const sourceId = `<inline-${nextInlineExtensionIndex++}>`;
				const loaded = await loadExtensionFromFactory(factory, cwd, eventBus, extensionsResult.runtime, sourceId);
				extensionsResult.extensions.push(loaded);
				if (i < rebindableInlineExtensionCount) {
					extensionsResult.preparedExtensions ??= [];
					extensionsResult.preparedExtensions.push({
						path: sourceId,
						resolvedPath: sourceId,
						factory,
						error: null,
					});
				}
			}
		}
		const deferredExtensionPaths = restrictToolNames ? [] : (options.deferredExtensionPaths ?? []);
		// Deferred extensions append to the forwarded lists after the session
		// captured them, so subagents and forks still inherit them.
		if (deferredExtensionPaths.length > 0) extensionsResult.preparedExtensions ??= [];
		toolSession.preparedExtensions = extensionsResult.preparedExtensions;

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		if (!restrictToolNames) {
			const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
			modelRegistry.syncExtensionSources(activeExtensionSources);
			modelRegistry.clearSourceRegistrations(new Set(activeExtensionSources));
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			const restoreSessionModel = (): boolean => {
				for (let i = 0; i < sessionRetryLimit; i++) {
					const restored = resolveSessionModelSelector(modelRegistry, sessionModelStrings[i]);
					if (restored) {
						const restoredModel = restored.model;
						model = restoredModel;
						modelFallbackMessage = undefined;
						restoredSessionModelIndex = i;
						restoredSessionThinkingLevel = restored.thinkingLevel;
						// Recompute thinking-level from scratch against the reclaimed
						// model: any value derived from the earlier fallback model's
						// `thinking.defaultLevel` must not become sticky.
						adoptThinkingForModel(restoredModel);

						return true;
					}
				}
				return false;
			};
			restoreSessionModel();
		}
		// Exhaust persisted candidates (including configured and extension discovery)
		// before permitting a settings-default or first-available substitution.
		if (sessionModelStrings.length > 0 && restoredSessionModelIndex < 0) {
			throw new SessionModelRestoreError(sessionModelStrings[0]);
		}
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Use the same CLI resolver as the immediate path so bare role
		// names, exact model names, and provider selectors keep one precedence rule.
		if (!model && deferredModelPatterns.length > 0) {
			const matchPreferences = getModelMatchPreferences(settings);
			const disabledProviders = new Set(cfgDisabledProviders.get(settings));
			const allEnabledModels =
				disabledProviders.size === 0
					? modelRegistry.getAll()
					: modelRegistry.getAll().filter(candidate => !disabledProviders.has(candidate.provider));
			const expandedModelPatterns = deferredModelPatterns.flatMap(pattern =>
				pattern
					.split(",")
					.map(selector => selector.trim())
					.filter(Boolean),
			);
			for (const selector of expandedModelPatterns) {
				const resolved = resolveCliModel({
					cliModel: selector,
					modelRegistry,
					settings,
					preferences: matchPreferences,
				});
				if (!resolved.model || disabledProviders.has(resolved.model.provider)) continue;
				model = resolved.model;
				modelFallbackMessage = undefined;
				if (resolved.thinkingLevel !== undefined) restoredSessionThinkingLevel = resolved.thinkingLevel;
				adoptThinkingForModel(model);

				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				// A single provider-qualified selector names its closest siblings, the same
				// hint `resolveCliModel` gives before the selector was deferred here.
				const hint =
					deferredModelPatterns.length === 1 ? providerModelHint(deferredModelPatterns[0], allEnabledModels) : "";
				modelFallbackMessage = `Model ${requested} not found${hint ? `.${hint}` : ""}`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && deferredModelPatterns.length === 0) {
			// Retry the configured default role against the current catalog,
			// setting `model` (+ thinking level) when it resolves. Extension
			// factories register providers AFTER the early `defaultRoleSpec`
			// resolution, and configured discovery providers may still be
			// mid-discovery, so a role pointing at such a model (an openai-compat
			// plugin's `posthog/claude-opus-4-8`, a models.yml `openai-models-list`
			// endpoint) returned `undefined` there. Without this retry the
			// `pickDefaultAvailableModel` fallback below happily replaces the
			// user's configured default with a bundled provider's default whenever
			// a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issues #3569, #6162)
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;
				// Re-resolve the allowed set: extension factories and discovery
				// refreshes above may have registered models not visible earlier.
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
				});
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;
				// Recompute the thinking level against the now-real model.
				// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
				// so the role's explicit selector (e.g. `:max`) now applies.
				adoptThinkingForModel(resolvedDefaultModel);

				return true;
			};

			await tryResolveDefaultRole();

			if (!model) {
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth), provider =>
					modelRegistry.hasConcreteAuth(provider),
				);

				if (!model && !settings.getModel() && pick) {
					model = pick;
					adoptThinkingForModel(pick);
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = cfgEnabledModels.get(settings);
				modelFallbackMessage = settings.getModel()
					? `Configured model ${settings.getModel()} is unavailable. Configure its credentials or explicitly select a model with /model.`
					: patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No default model selected. Configure an endpoint and model in models.yml, then select it with /model or --model.";
			}
		}

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				for (const result of createInterruptedToolResults(existingBranch)) sessionManager.appendMessage(result);
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () =>
					deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
				);
			}
		}

		// Discovery started with the other cwd/agentDir-only scans, before model
		// resolution and tool construction, so command module I/O stays off the
		// session-creation critical path.
		const customCommandsResult = await customCommandsPromise;
		if (!options.disableExtensionDiscovery && !restrictToolNames) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// The runner is created unconditionally — even with zero extensions loaded — because the
		// `ExtensionToolWrapper` installed below is the only place the per-tool approval gate runs.
		// A conditional runner means the approval system silently disappears for users with no
		// extensions, contradicting non-yolo `tools.approvalMode` settings without feedback.
		// (The builtin autoresearch extension is unconditionally loaded above, so this scenario
		// is unreachable; unconditional runner construction keeps that invariant explicit and
		// prevents future optional extensions from silently re-opening the hole.)
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			settings,
			localProtocolOptions,
			() => (hasSession ? session.getAsyncJobSnapshot() : null),
			Object.freeze({
				kind: isSubagentSession ? "sub" : "main",
				id: resolvedAgentId,
				name: resolvedAgentName,
				depth: taskDepth,
				...(options.parentAgentId ? { parentId: options.parentAgentId } : {}),
			}),
			createAnnotationsAPI,
		);
		// Register user input waits so peer agents can observe the session's waiting state.
		const trackUserWait: UserWaitTracker = dialog => (hasSession ? session.waitForUser(dialog) : dialog());
		extensionRunner.setUserWaitTracker(trackUserWait);

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext, trackUserWait);
		toolSession.getToolContext = () => toolContextStore.getContext();
		const setSessionActiveToolNames = (names: Iterable<string>): void => {
			const snapshot = Array.from(names);
			setActiveToolNames(snapshot);
			toolContextStore.setToolNames(snapshot);
		};
		// Native built-in implementations backing same-tool `ctx.invokeTool`, so a tool that
		// re-registers a built-in (e.g. wrapping `write`) can delegate to the original — reaching the
		// unwrapped native execute, which inherits the caller's already-granted approval rather than
		// re-running the gate. Seeded from the xdev registry when present (it retains discoverable
		// built-in capabilities that xdev partitioning removes from the active tool array), else
		// from the built-in registry; captured before the ExtensionToolWrapper pass so the natives
		// stay unwrapped. The extension runner exposes it to re-registered tools via createContext.
		const nativeToolsByName = new Map<string, Tool>(toolSession.xdev?.tools ?? undefined);

		const registeredTools = restrictToolNames ? [] : extensionRunner.getAllRegisteredTools();
		const initialRegisteredTools = new WeakSet(registeredTools);
		// Manager-owned proxies register like SDK custom tools but are classified
		// as manager tools via their origins. An explicitly supplied custom tool
		// keeps its name: the proxy is dropped rather than registered as a loser
		// whose manager classification would let a refresh replace the winner.
		const explicitCustomTools =
			restrictToolNames && options.allowRestrictedCustomTools !== true
				? []
				: (options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? []);
		const explicitCustomToolNames = new Set(explicitCustomTools.map(tool => tool.name));
		const sdkMcpTools = restrictToolNames
			? []
			: (options.mcpTools ?? []).filter(tool => !explicitCustomToolNames.has(tool.name));
		initialMcpManagerTools.push(...sdkMcpTools);
		const sdkCustomTools = [...sdkMcpTools, ...explicitCustomTools];
		const sdkCustomToolNames = new Set(sdkCustomTools.map(tool => tool.name));
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>", sourceInfo: extensionToolSourceInfo(definition, "<sdk>") };
			}),
		];
		// `wrapToolWithMetaNotice` runs the centralized large-output → artifact spill.
		// Built-in tools get it in `createTools`; extension, SDK-custom, image-gen,
		// and startup (non-deferred) MCP tools all funnel through here, so apply
		// it once at this adapter boundary (idempotent — a no-op if already wrapped).
		const wrappedExtensionTools: Tool[] = deduplicateMCPToolsByName(
			wrapRegisteredTools(allCustomTools, extensionRunner).map(wrapToolWithMetaNotice),
		);
		const initialMcpManagerToolNames = new Set<string>();
		for (const tool of wrappedExtensionTools) {
			const originKey = getMCPToolOriginKey(tool);
			const matchesManagerOrigin =
				originKey !== undefined &&
				initialMcpManagerTools.some(
					managerTool => managerTool.name === tool.name && getMCPToolOriginKey(managerTool) === originKey,
				);
			if (matchesManagerOrigin) initialMcpManagerToolNames.add(tool.name);
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const builtInRegistryToolNames = toolSession.xdev?.builtInNames ?? new Set(toolRegistry.keys());
		// Capture the native built-in implementations before extension re-registration replaces registry
		// entries and before the ExtensionToolWrapper pass below, so `ctx.invokeTool` reaches the
		// unwrapped native execute (inheriting the caller's already-granted approval, not re-gating).
		for (const [name, tool] of toolRegistry) {
			nativeToolsByName.set(name, tool);
		}
		if (!restrictToolNames && !toolRegistry.has("goal") && cfgGoalEnabled.get(settings)) {
			const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
			if (goalTool) {
				const wrapped = wrapToolWithMetaNotice(goalTool);
				toolRegistry.set(goalTool.name, wrapped);
				builtInRegistryToolNames.add(goalTool.name);
				nativeToolsByName.set(goalTool.name, wrapped);
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.delete(tool.name);
		}
		// Expose the native built-ins to same-tool `ctx.invokeTool` on re-registered tools. Set after
		// the override loop so the map holds the natives, not the extension replacements. The context
		// factory is the loop's own tool context, so a delegated native call sees ordinary session state.
		extensionRunner.setNativeToolResolver(name => {
			const tool = nativeToolsByName.get(name);
			return tool ? { tool, makeContext: () => toolContextStore.getContext() } : undefined;
		});
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
					initialMcpManagerToolNames.add(name);
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}

		let writeRegistration: Promise<boolean> | undefined;
		const ensureWriteRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("write")) return Promise.resolve(builtInRegistryToolNames.has("write"));
			writeRegistration ??= (async () => {
				const writeTool = await logger.time("createTools:write:session", BUILTIN_TOOLS.write, toolSession);
				if (!writeTool || toolRegistry.has("write")) return builtInRegistryToolNames.has("write");
				const nativeWrite = wrapToolWithMetaNotice(writeTool);
				toolRegistry.set(writeTool.name, new ExtensionToolWrapper(nativeWrite, extensionRunner) as Tool);
				builtInRegistryToolNames.add(writeTool.name);
				nativeToolsByName.set(writeTool.name, nativeWrite);
				return true;
			})().finally(() => {
				writeRegistration = undefined;
			});
			return writeRegistration;
		};

		// Goal mode can be enabled after the session was created (settings UI,
		// `/set goal.enabled true`). The eager registration above only runs at
		// creation, so a runtime enable would leave the registry without `goal`
		// and `#enterGoalMode`'s `setActiveToolsByName([...tools, "goal"])` would
		// silently drop the unknown name — goal mode starts, the model is told to
		// use the `goal` tool, and the call fails (issue #9444). Register it
		// lazily on demand, mirroring `ensureWriteRegistered`.
		let goalRegistration: Promise<boolean> | undefined;
		const ensureGoalRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("goal")) return Promise.resolve(true);
			if (restrictToolNames || !cfgGoalEnabled.get(settings)) return Promise.resolve(false);
			goalRegistration ??= (async () => {
				const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
				if (!goalTool || toolRegistry.has("goal")) return toolRegistry.has("goal");
				const nativeGoal = wrapToolWithMetaNotice(goalTool);
				toolRegistry.set(goalTool.name, new ExtensionToolWrapper(nativeGoal, extensionRunner) as Tool);
				builtInRegistryToolNames.add(goalTool.name);
				nativeToolsByName.set(goalTool.name, nativeGoal);
				return true;
			})().finally(() => {
				goalRegistration = undefined;
			});
			return goalRegistration;
		};

		// `tools.xdev` flips allocate or release the `xd://` state createTools builds
		// over the canonical map; the session re-partitions on its next apply. Like
		// createTools, mounting needs a built-in `write` transport.
		const syncXdevState = (): void => {
			const wanted =
				!restrictToolNames &&
				cfgToolsXdev.get(settings) &&
				toolRegistry.has("write") &&
				builtInRegistryToolNames.has("write");
			if (wanted === (toolSession.xdev !== undefined)) return;
			if (wanted) {
				toolSession.xdev = createXdevState(toolSession, toolRegistry, builtInRegistryToolNames);
				return;
			}
			toolSession.xdev?.mountedNames.clear();
			toolSession.xdev = undefined;
		};
		// Settings-gated tools follow live settings: `AgentSession.reconcileBuiltinTools`
		// (run on every gating setting change) calls this under the registry lock.
		// Built-ins re-run the shared `createTools` plan, so explicit lists, restricted
		// sessions and task depth are honored exactly as at construction; a same-named
		// extension tool keeps its registry slot and only its native backing changes.
		const reconcileSettingsGatedTools = async (
			isBuiltIn: (name: string) => boolean,
		): Promise<SettingsGatedToolDelta> => {
			const plan = await resolveBuiltinToolPlan(toolSession, options.toolNames);
			const planned = new Set(plan.names);
			const explicitToolNames = options.toolNames ? new Set(normalizeToolNames(options.toolNames)) : undefined;
			const added: { name: string; builtIn: boolean; activate: boolean }[] = [];
			const removed: string[] = [];
			for (const name of SETTINGS_GATED_BUILTIN_TOOL_NAMES) {
				const registered = toolRegistry.has(name);
				if (!plan.isAllowed(name)) {
					nativeToolsByName.delete(name);
					if (!registered || !isBuiltIn(name)) continue;
					toolRegistry.delete(name);
					builtInRegistryToolNames.delete(name);
					removed.push(name);
					continue;
				}
				if (!planned.has(name) || (registered && (isBuiltIn(name) || nativeToolsByName.has(name)))) continue;
				const tool = await logger.time(`createTools:${name}:settings`, BUILTIN_TOOLS[name], toolSession);
				if (!tool) continue;
				const native = wrapToolWithMetaNotice(tool);
				nativeToolsByName.set(name, native);
				if (registered) continue;
				toolRegistry.set(name, new ExtensionToolWrapper(native, extensionRunner) as Tool);
				builtInRegistryToolNames.add(name);
				// As at construction: explicit lists activate requested names, session-managed
				// force-includes and the checkpoint/rewind pair; other auto-includes stay inactive.
				const activate = explicitToolNames
					? explicitToolNames.has(name) ||
						SESSION_MANAGED_BUILTIN_TOOL_NAMES.includes(name) ||
						name === "checkpoint" ||
						name === "rewind"
					: native.hidden !== true;
				added.push({ name, builtIn: true, activate });
			}
			syncXdevState();
			return { added, removed, xdev: toolSession.xdev };
		};

		// Existing staged/device paths need write registered before active-set assembly.
		// Deferred MCP also registers it now, but refresh activates it only after a server connects.
		// xd:// mounts ride the session's write grant: createTools either saw a
		// granted write tool or registered a device-only transport one for an
		// explicit-list session that omitted it, so xdev state always implies one.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const planModeAvailable = cfgPlanEnabled.get(settings);
		if (!restrictToolNames && (hasDeferrableTools || planModeAvailable || deferMCPDiscoveryForUI)) {
			await ensureWriteRegistered();
		}

		// Cursor and the agent loop may call a mounted device by its top-level
		// name. Resolve that name from the canonical map and apply the same
		// execution-only ACP decorator used by `write xd://<tool>`; docs and
		// renderer lookup continue to use the undecorated canonical instance.
		//
		// `advertised` is the agent loop's per-request tool snapshot, the very set
		// exact-name dispatch just searched. It is NOT read from `agent.state`:
		// an MCP `tools/list_changed` reassigns the agent's tools mid-stream, so
		// live state can hold a roster the model never saw for this request, and
		// recovering a name against it would dispatch a tool that was never
		// advertised while exact dispatch still answered from the snapshot.
		// Callers with no request snapshot (the Cursor exec bridge) pass none and
		// get device resolution only.
		const resolveDeviceTool = (name: string, advertised: readonly AgentTool[] = []): AgentTool | undefined => {
			const bareName = stripXdUrlPrefix(name);
			const state = toolSession.xdev;
			// An exact mounted name is the name itself, not a guess.
			const exactDevice = state ? resolveMountedXdevExecutable(state, bareName) : undefined;
			if (exactDevice) return exactDevice;
			// One lookup spanning BOTH presentation sets this request can reach, so
			// the uniqueness rule applies across their union: an alias answered by
			// a mounted device AND by a different advertised tool is ambiguous, not
			// a race the mounted set happens to win.
			//
			// `xd://` state exists only when `tools.xdev` is on and the session is
			// unrestricted (`createTools`), so the advertised arm is what recovers
			// an MCP alias when there is no state at all. That arm reads a set
			// already execution-wrapped by `#applyActiveToolsByName`, so a
			// deselected, `defaultInactive`, or hidden tool stays unreachable and
			// no permission wrapper is bypassed. Only `mcp__`
			// names yield candidates, so no first-party tool is reachable this way.
			return resolveMCPToolAlias(
				bareName,
				candidate =>
					(state ? resolveMountedXdevExecutable(state, candidate) : undefined) ??
					advertised.find(tool => tool.name === candidate),
			);
		};
		// Mounted devices are absent from the advertised tool set, so a miss on a
		// device name has nothing to suggest unless the loop is told they exist.
		const suggestDeviceToolNames = (): Iterable<string> => toolSession.xdev?.mountedNames ?? [];

		// Prompt descriptors and request-tool pruning use the same explicit setting.
		const resolveInlineToolDescriptors = (): boolean =>
			shouldInlineToolDescriptors(cfgInlineToolDescriptors.get(settings));
		// The process agent dir uses the process-wide store; a session rooted in
		// another agent dir keeps its own, closed when the session is disposed.
		const ownedSkillDescriptionStore =
			path.resolve(agentDir) === path.resolve(getAgentDir())
				? undefined
				: openSessionSkillDescriptionStore(agentDir);
		const skillDescriptions = new SkillDescriptionCatalog({
			store: ownedSkillDescriptionStore,
			// Held until AgentSession exists: before then the root cost gate does not, so a request
			// sent from the startup prompt render could go out ungated (see `startCompression` below).
			deferCompression: true,
			compress: createSkillDescriptionCompressor(modelRegistry, {
				getModel: () => agent?.state.model ?? model,
				getCostGate: currentCostGate,
				getTelemetry: () =>
					agent
						? resolveTelemetry(agent.telemetry, agent.sessionId)
						: resolveTelemetry(options.telemetry, providerSessionId),
			}),
		});
		// Instructions from MCP servers the host connects outside `mcpManager`
		// (ACP client-declared servers); installed via
		// `AgentSession.setMcpServerInstructionsSource`.
		let hostMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
		/** Live server instructions from the session's own manager and any host source, sorted by server name. */
		const readMcpServerInstructions = (): Map<string, string> | undefined => {
			const own = mcpManager?.getServerInstructions();
			const hosted = hostMcpServerInstructions?.();
			if (!hosted || hosted.size === 0) return own;
			if (!own || own.size === 0) return hosted;
			return new Map([...own, ...hosted].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
		};
		const rebuildSystemPrompt: SystemPromptRebuilder = async (
			toolNames,
			tools,
			xdev,
		): Promise<BuildSystemPromptResult> => {
			const promptCwd = sessionManager.getCwd();
			let activeRepoContext = initialActiveRepoContext;
			// Re-discover rules and context files from disk on every session-scoped
			// rebuild. The rule buckets are otherwise frozen at
			// session creation, so a `RULES.md` (or any rule) created or edited while omp
			// runs never reaches the prompt on /clear or /new until restart (issue #10940).
			// resetCapabilities() clears the fs cache at those boundaries, so this observes
			// the current file. TTSR registrations are replaced from the new snapshot while
			// injection state is retained only for rule names that remain registered.
			// Sessions handed an explicit rule set (subagents inherit the parent's) keep it
			// but still re-bucket, so live `ttsr.*` filter changes apply to them too.
			if (hasSession) {
				// These reads share only the cwd and discovery scope. Start them together:
				// a slow repository lookup must not delay context files or rules, including
				// the first refresh after session_start hooks have edited those files.
				const [repoContext, refreshedContextFiles, ruleItems] = await Promise.all([
					logger.time("resolveActiveRepoContext", resolveRepoContext, promptCwd),
					pinnedContextFiles === undefined
						? logger.time("discoverContextFiles", discoverContextFiles, promptCwd, agentDir, [
								...cfgDisabledExtensions.get(settings),
							])
						: undefined,
					options.rules ??
						logger
							.time("rediscoverRules", () =>
								loadCapability<Rule>(ruleCapability.id, { cwd: promptCwd, agentDir }),
							)
							.then(result => result.items),
				]);
				activeRepoContext = repoContext;
				if (refreshedContextFiles !== undefined) {
					contextFiles = contextFileFilter(refreshedContextFiles);
					toolSession.contextFiles = contextFiles;
					session.setAdvisorContextPrompt(formatAdvisorContextPrompt(contextFiles));
				}
				const ttsrSettings = cfgTtsr.get(settings);
				const buckets = bucketRules(ruleItems, ttsrManager, {
					builtinRules: ttsrSettings.builtinRules,
					disabledRules: ttsrSettings.disabledRules,
					agentName: resolvedAgentName,
					replaceTtsrRules: true,
				});
				rulebookRules = buckets.rulebookRules;
				alwaysApplyRules = buckets.alwaysApplyRules;
				const nextActiveRules = [...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()];
				// Refresh the session-local snapshots too: `rule://` resolution reads
				// `toolSession.activeRules` and spawned subagents inherit `toolSession.rules`,
				// so leaving the construction-time arrays would advertise a new `rule://<name>`
				// the read tool rejects and hand children the stale set.
				toolSession.rules = ruleItems;
				toolSession.activeRules = nextActiveRules;
				if (!options.parentTaskPrefix) {
					setActiveRules(nextActiveRules);
				}
			}
			const inlineToolDescriptors = resolveInlineToolDescriptors();
			// Unset only during the initial build; the agent is constructed with it.
			if (agent) agent.pruneToolDescriptions = inlineToolDescriptors;
			// A fixed string or array in systemPrompt replaces all generated blocks.
			// Preserve the bookkeeping above, but skip discovering or rendering a
			// template whose output would be discarded.
			if (options.systemPrompt !== undefined && typeof options.systemPrompt !== "function") {
				return {
					systemPrompt: typeof options.systemPrompt === "string" ? [options.systemPrompt] : options.systemPrompt,
				};
			}

			// Build combined append prompt: mounted MCP route guidance and optional
			// MCP server instructions. For UI
			// sessions MCP discovery is deferred, so the initial registry and
			// `getServerInstructions()` are empty until the background connect
			// completes; the rebuild that `refreshMCPTools` triggers post-discovery
			// then picks up the mounted routes and any connected-server instructions.
			const serverInstructions = readMcpServerInstructions();
			const appendParts: string[] = [];
			// List each mounted MCP tool once. A routed tool that the xd:// catalog
			// would list carries its catalog summary on the route line and gets no
			// catalog line; a tool the route bound omits keeps its catalog line.
			const xdevPromptDocs = xdev
				? planXdevPromptDocs(xdev, cfgToolsXdevDocs.get(settings), cfgToolsXdevInlineDevices.get(settings))
				: undefined;
			const projection = projectMountedMCPXdevGuidance(collectMountedMCPToolRoutes(xdev ? listXdevTools(xdev) : []));
			const routedCatalogNames = new Set(
				projection.mappings
					.filter(mapping => xdevPromptDocs?.catalog.has(mapping.name))
					.map(mapping => mapping.name),
			);
			if (projection.mappings.length > 0 || projection.hasOmittedMappings) {
				appendParts.push(
					prompt
						.render(mcpXdevGuidanceTemplate, {
							tools: projection.mappings.map(mapping => ({
								mcpToolName: mapping.label,
								path: mapping.path,
								summary: xdevPromptDocs?.catalog.get(mapping.name),
							})),
							hasCatalogOnlyTools: routedCatalogNames.size > 0,
							hasOmittedTools: projection.hasOmittedMappings,
						})
						.trim(),
				);
			}
			if (serverInstructions && serverInstructions.size > 0) {
				appendParts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					appendParts.push(`### ${srvName}\n${truncated}`);
				}
			}
			const appendPrompt = composeAppendPrompt(appendParts, options.appendSystemPrompt);
			const includeWorkspaceTree = cfgIncludeWorkspaceTree.get(settings);
			if (includeWorkspaceTree && !workspaceTreePromise) {
				const scan = scanWorkspaceTree();
				workspaceTreePromise = scan;
				scan.then(
					tree => {
						lateWorkspaceTree = tree;
					},
					() => {},
				);
			}
			// Mounted xd:// readers stay out of the direct inventory, but their skill
			// capability still drives catalog/URI guidance: project them into the
			// compact metadata map (inventory rendering stays driven by `toolNames`).
			const mountedPromptToolNames = xdev ? xdevEntries(xdev).map(entry => entry.name) : [];
			const promptTools = projectSystemPromptToolMetadata(
				tools,
				!inlineToolDescriptors
					? { mode: "compact", toolNames: [...toolNames, ...mountedPromptToolNames] }
					: { mode: "full" },
			);
			const defaultPrompt = await buildSystemPromptInternal({
				cwd: promptCwd,
				additionalWorkspaceRoots: sessionManager.getAdditionalDirectories(),
				noContextFiles: options.noContextFiles,
				excludeAgentsMd,
				xdevTools: xdev ? xdevEntries(xdev) : [],
				xdevDocs: xdevPromptDocs ? renderXdevPromptDocs(xdevPromptDocs, routedCatalogNames) : "",
				resolvedCustomPrompt: options.customSystemPrompt,
				systemPromptTemplate: options.systemPromptTemplate,
				skills: cfgSkillful.get(settings) ? (session?.promptSkills ?? skills) : [],
				skillDescriptions,
				contextFiles,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: cfgSkills.get(settings),
				inlineToolDescriptors,
				nativeTools: true,
				intentField: cfgToolsIntentTracing.get(settings) ? INTENT_FIELD : undefined,
				// task.eager steers the top-level agent only; subagents keep the model's own delegation policy.
				eagerTasks: agentKind === "main" && cfgTaskEager.get(settings) !== "default",
				eagerTasksAlways: agentKind === "main" && cfgTaskEager.get(settings) === "always",
				taskBatch: cfgTaskBatch.get(settings),
				taskMaxConcurrency: cfgTaskMaxConcurrency.get(settings),
				scoutAvailable: isScoutSpawnable(cfgTaskDisabledAgents.get(settings), options.spawns ?? "*"),

				taskIrcEnabled: !restrictToolNames && isIrcEnabled(settings, options.taskDepth ?? 0),
				autoQaEnabled: !restrictToolNames && isAutoQaEnabled(settings),
				ovnfs: ovnfsCommand(settings),
				writeTransportOnly:
					toolSession.deviceOnlyWrite === true && toolSession.pendingFullWriteDescription !== true,
				secretsEnabled: obfuscator?.obfuscates() === true,
				workspaceTree: workspaceTreePromise ?? emptyWorkspaceTree,
				includeWorkspaceTree,
				securityEnabled: cfgSecurityEnabled.get(settings),
				settingsApproval: toolSession.settingsApproval === true,
				outReplies: outRepliesActive(settings, tuiTranscript),
				evalPreludes: toolSession.getAdvertisedEvalPreludes?.(),
				model: getActiveModelString(),
				includeModelInPrompt: cfgIncludeModelInPrompt.get(settings),
				personality: agentKind === "sub" ? "none" : cfgPersonality.get(settings),
				subagent: agentKind === "sub",
				renderMermaid: tuiTranscript && cfgTuiRenderMermaid.get(settings),
				renderSvg: tuiTranscript && cfgTuiRenderSvg.get(settings),
				autoGraph: tuiTranscript && cfgTuiAutoGraph.get(settings) !== "off",
				reactions: agentKind === "main" && options.hasUI === true && cfgTuiReactions.get(settings),
				activeRepoContext,
			});

			if (typeof options.systemPrompt !== "function") {
				return defaultPrompt;
			}
			const customPrompt = options.systemPrompt(defaultPrompt.systemPrompt);
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the subagent's prompts and idle-reminders demand a
		// `yield` call to terminate. The tool registry already includes `yield` (see
		// `createTools`), but an explicit `toolNames` list (agent frontmatter `tools` omits
		// it) would otherwise drop it from the active set — leaving the model unable to
		// satisfy the contract.
		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes("yield")
		) {
			explicitlyRequestedToolNames.push("yield");
		}
		// Session-managed builtins may be force-included by createTools. Keep the
		// active set consistent with that registry decision, using built-in
		// provenance so same-named extension tools are never force-activated.
		if (!restrictToolNames && explicitlyRequestedToolNames) {
			for (const name of SESSION_MANAGED_BUILTIN_TOOL_NAMES) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		// Checkpoint and rewind are a pair: `createTools` auto-includes the sister
		// tool in the registry, but an explicit `toolNames` list would otherwise
		// drop it from the ACTIVE set — leaving the agent able to checkpoint but
		// unable to rewind (or vice versa). Mirror the pairing here. Unlike the
		// manage_skill/learn mirror above, this is a safety pairing — it applies
		// to restricted sessions too.
		if (explicitlyRequestedToolNames) {
			if (builtInToolNames.includes("checkpoint") && !explicitlyRequestedToolNames.includes("rewind")) {
				explicitlyRequestedToolNames.push("rewind");
			} else if (builtInToolNames.includes("rewind") && !explicitlyRequestedToolNames.includes("checkpoint")) {
				explicitlyRequestedToolNames.push("checkpoint");
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const defaultInactiveToolNames = new Set(
			toolNamesFromRegistry.filter(name => {
				const tool = toolRegistry.get(name);
				return tool?.defaultInactive === true || tool?.hidden === true;
			}),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const explicitlyRequestedToolNameSet = explicitlyRequestedToolNames
			? new Set(explicitlyRequestedToolNames)
			: undefined;
		const inheritedMountedNames = options.mountedToolNames && new Set(options.mountedToolNames);
		const presentationPinnedToolNames =
			explicitlyRequestedToolNames && inheritedMountedNames
				? new Set(explicitlyRequestedToolNames.filter(name => !inheritedMountedNames.has(name)))
				: explicitlyRequestedToolNameSet;
		const xdevReadAvailable =
			builtInRegistryToolNames.has("read") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("read"));
		const xdevWriteAvailable =
			builtInRegistryToolNames.has("write") &&
			(explicitlyRequestedToolNameSet === undefined ||
				explicitlyRequestedToolNameSet.has("write") ||
				toolSession.deviceOnlyWrite === true);
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		let initialToolNames = [...initialRequestedActiveToolNames];

		// Custom tools and extension-registered tools are always included
		// unless the effective registry winner is hidden / defaultInactive. Restricted callers own the list.
		const alwaysInclude: string[] = restrictToolNames
			? []
			: [...sdkCustomTools.map(t => t.name), ...registeredTools.map(t => t.definition.name)].filter(
					name => !defaultInactiveToolNames.has(name),
				);
		for (const name of alwaysInclude) {
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		const registrationInput = {
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running" as const,
		};
		registeredAgentRef =
			options.expectedAgentRef === undefined
				? agentRegistry.register(registrationInput)
				: agentRegistry.registerIfAvailable(registrationInput, options.expectedAgentRef);
		if (!registeredAgentRef && options.expectedAgentRef === null) {
			// A fresh spawn collided with an existing id. If that id is held by a
			// provably-dead parked corpse — no live session, no reviver — reclaim it
			// so this new generation can take the id instead of failing forever at
			// construction. Without this, one such corpse (isolated-run park,
			// interrupted construction) poisons the id for the whole process (#8490).
			// The reclaim is gated by the lifecycle owner and only touches the
			// registry it manages; the corpse's transcript stays at history://.
			const stale = agentRegistry.get(resolvedAgentId);
			const lifecycle = AgentLifecycleManager.global();
			if (stale && lifecycle.manages(agentRegistry) && (await lifecycle.reclaimDeadCorpse(resolvedAgentId, stale))) {
				registeredAgentRef = agentRegistry.registerIfAvailable(registrationInput, null);
			}
		}
		if (!registeredAgentRef) {
			throw new Error(`Agent "${resolvedAgentId}" is already owned by another session generation.`);
		}
		// A reused parked ref remains parked until the new AgentSession is fully
		// constructed and attached. Startup failure therefore leaves it revivable.
		hasRegistered = options.expectedAgentRef === undefined || options.expectedAgentRef === null;

		// Partition the initial enabled set for the xd:// transport. Tool instances
		// remain in the canonical map; only presentation names move between layers.
		// Mounting requires both transport halves in the granted set (`read xd://`
		// discovers, `write xd://<tool>` executes); explicit-list sessions granted
		// `read` without `write` can use the device-only transport registered by
		// createTools without surfacing it when no device needs it.
		if (toolSession.xdev) {
			const topLevelToolNames: string[] = [];
			const mountedNames: string[] = [];
			for (const name of initialToolNames) {
				const tool = toolRegistry.get(name);
				const explicitlyRequested = presentationPinnedToolNames?.has(name) === true;
				if (tool && xdevReadAvailable && xdevWriteAvailable && !explicitlyRequested && isMountableUnderXdev(tool))
					mountedNames.push(name);
				else topLevelToolNames.push(name);
			}
			toolSession.xdev.mountedNames.clear();
			for (const name of mountedNames) toolSession.xdev.mountedNames.add(name);
			initialToolNames = topLevelToolNames;
			const deviceTransportNeeded =
				mountedNames.length > 0 ||
				initialToolNames.some(name => toolRegistry.get(name)?.deferrable === true) ||
				toolSession.getPlanModeState?.()?.enabled === true;
			if (deviceTransportNeeded && xdevWriteAvailable && !initialToolNames.includes("write")) {
				initialToolNames.push("write");
			}
		}

		setSessionActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
			toolSession.xdev,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Keep image blocks off the wire when they'd be rejected: either the user
		// disabled images (`images.blockImages`) or the active model's wire sends
		// none. The latter covers switching from a vision model to a text-only
		// one mid-session — historical image blocks would otherwise be replayed to
		// a provider that 400s on them (#5400) — and routes that strip images,
		// whose blocks would otherwise be normalized and published for nothing.
		// Read both dynamically so a `/model` switch or setting change takes
		// effect on the next turn.
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (cfgImagesBlockImages.get(settings)) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !sendsImageInputOnWire(activeModel)) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};

		// Final convertToLlm: live provider replay drops API-level refusal errors,
		// then applies secret obfuscation to the remaining outbound context.
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = filterProviderReplayMessages(convertToLlmWithBlockImages(messages));
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages, signal);
			return wrapSteeringForModel(withContext);
		};
		// Per-request provider-context transforms. Obfuscate FIRST so secrets are
		// redacted from text before snapcompact rasterizes it into PNG frames. Clamp
		// to the provider budget before normalizing decoder-incompatible images so
		// dropped historical images never pay a transcode cost.
		// URL-mirrored images: providers that fetch image URLs get a broker URL
		// instead of inline base64. Decoration runs LAST among image transforms so
		// the served bytes are exactly the bytes that would have shipped inline.
		// Live-bound: `images.urls.*` changes rebuild the service between requests.
		const blobBroker = new LiveImageUrlService(settings, () => sessionManager.getCwd());
		disposeCallbacks.add(() => blobBroker.dispose());
		// Always installed; the getter-backed options are snapshotted per request,
		// so `snapcompact.*` changes apply on the next call (a no-op while both are off).
		const snapcompactInline = new SnapcompactInlineTransformer(
			{
				get renderSystemPrompt() {
					return cfgSnapcompactSystemPrompt.get(settings);
				},
				get renderToolResults() {
					return cfgSnapcompactToolResults.get(settings);
				},
				get shape() {
					return cfgSnapcompactShape.get(settings);
				},
			},
			// Journal the tokens each imaged tool result keeps off the wire
			// (frames never reach session.jsonl, so this is their only trace).
			createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
			// With a serving blob broker, frames become lazy URLs: rasterized
			// only when a provider fetches them, never held as pixels here.
			blobBroker,
		);
		// One transform per conversation: the date/cwd reminder remembers what each
		// conversation was sent, so the main loop and every advisor get their own.
		// Only the main loop journals its reminders in the session.
		const createTransformProviderContext = (journal?: DateCwdReminderJournal) => {
			const dateCwdReminder = new DateCwdReminderInjector(journal);
			return async (context: Context, transformModel: Model): Promise<Context> => {
				let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
				// The archive was sized for the model active at the last context build; a model switch may have lowered the budget.
				transformed = capArchiveFrameBytes(transformed, transformModel);
				transformed = await snapcompactInline.transform(transformed, transformModel);
				transformed = clampProviderContextImages(transformed, transformModel);
				transformed = await normalizeProviderContextImages(transformed);
				// After the model-specific normalizers: they carry better wording for the
				// cases they own (STB WebP), so this stays the backstop for everything
				// else, and it runs before the blob broker uploads any of these bytes.
				transformed = await dropUnreadableContextImages(transformed, transformModel);
				transformed = await blobBroker.decorateContext(transformed, transformModel);
				// Byte budget after decoration: URL/file-referenced images carry no inline bytes.
				transformed = clampProviderContextImageBytes(transformed, transformModel);
				// Keep per-request volatility out of the system prompt: the date/cwd
				// reminder rides on the first user turn so open-weight providers keep
				// their tool-schema prefix cache (#7404).
				return dateCwdReminder.transform(
					transformed,
					formatLocalCalendarDate(),
					normalizePromptPath(sessionManager.getCwd()),
				);
			};
		};
		const transformProviderContext = createTransformProviderContext(
			createSessionDateCwdReminderJournal(sessionManager),
		);
		const onPayload = async (payload: unknown, model?: Model, signal?: AbortSignal) => {
			return await extensionRunner.emitBeforeProviderRequest(payload, model, signal);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model, signal) => {
			await extensionRunner.emitAfterProviderResponse(response, model, signal);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);

		// Resolve the explicitly configured service tier for the selected model.
		const resolvedServiceTierByFamily = options.resolveServiceTierByFamily?.(model);
		const configuredServiceTierByFamily =
			resolvedServiceTierByFamily ??
			(hasServiceTierEntry
				? (existingSession.serviceTier ?? {})
				: buildServiceTierByFamily(cfgTierOpenai.get(settings)));
		const persistInitialServiceTier =
			options.openAIServiceTier !== undefined || resolvedServiceTierByFamily !== undefined;
		const initialServiceTierByFamily = { ...configuredServiceTierByFamily };
		if (options.openAIServiceTier === null) {
			delete initialServiceTierByFamily.openai;
		} else if (options.openAIServiceTier !== undefined) {
			initialServiceTierByFamily.openai = options.openAIServiceTier;
		}

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps in-flight caps and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		// Every attempt this session sends (primary, side-channel, and advisor) passes the session tree's cost gate once it holds its
		// concurrency slot, and adds its cost to the gate before releasing the slot.
		const settingsBoundStreamFn = wrapStreamFnWithBlobUrlFallback(
			guardStreamFn(createSettingsAwareStreamFn(settings), currentCostGate),
			() => blobBroker.current,
		);
		// Outbound credential-pattern redaction follows THIS session's `secrets.enabled` per
		// request, not the process-wide switch (the newest effect holder's): concurrent ACP/SDK
		// sessions in one process each keep their own policy.
		const settingsAwareStreamFn: StreamFn = (streamModel, context, streamOptions) =>
			withCredentialRedaction(cfgSecretsEnabled.get(settings), () =>
				settingsBoundStreamFn(streamModel, context, streamOptions),
			);
		// Primary-agent provider options read per
		// request, so `/settings` budget changes reach the next call.
		const primaryStreamFn: StreamFn = (streamModel, context, streamOptions) =>
			settingsAwareStreamFn(streamModel, context, {
				...streamOptions,
				thinkingBudgets: streamOptions?.thinkingBudgets ?? cfgThinkingBudgets.get(settings),
			});
		const transformToolCallArguments = (args: Record<string, unknown>): Record<string, unknown> => {
			let result = args;
			const maxTimeout = cfgToolsMaxTimeout.get(settings);
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = deobfuscateToolArguments(obfuscator, result);
			}
			return result;
		};
		// Live-bound speculation config: the Agent captures this object once at
		// construction but reads `enabled` per turn (and `maxInFlight` per drain)
		// through getters, so mid-session settings UI toggles take effect without
		// a session recreate. The single shared host keeps its evidence across
		// toggles; per-turn coordinator close never touches it.
		const speculativeToolExecution = createSpeculativeToolExecutionConfig(settings, toolSession, extensionRunner);

		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: cfgSteeringMode.get(settings),
			followUpMode: cfgFollowUpMode.get(settings),
			interruptMode: cfgInterruptMode.get(settings),
			...cfgSampling.get(settings),
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: effectiveGetApiKey,
			streamFn: (streamModel, context, streamOptions) => {
				options.assertDispatchModel?.(streamModel);
				// The loop checks the cap before each request, but a side request can finish
				// in between: refuse here, as this run's refusal, before announcing a dispatch.
				const refusal = currentCostGate()?.check();
				if (refusal) {
					session.reportCostCapRefusal(refusal);
					return Promise.reject(new CostCapError(refusal));
				}
				if (notifyFirstChatDispatch) {
					const cb = notifyFirstChatDispatch;
					notifyFirstChatDispatch = undefined;
					try {
						cb();
					} catch (error) {
						logger.warn("onFirstChatDispatch hook threw", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				const externalThinking =
					cfgExternalThinking.get(settings) &&
					agent.state.tools.some(tool => tool.name === "think") &&
					supportsExternalThinking(streamModel);
				if (streamOptions?.promptCacheKey === undefined) session?.promoteTaskSiblingCandidate(streamModel);
				const merged: SimpleStreamOptions = {
					...streamOptions,
					promptCacheKey: streamOptions?.promptCacheKey ?? session?.getPromptCacheKeyForModel(streamModel),
					forceReasoningOff: externalThinking || streamOptions?.forceReasoningOff,
				};
				const stream = primaryStreamFn(streamModel, context, merged);
				// A request that waited for a provider slot is checked again when it goes out.
				if (stream instanceof Promise) {
					stream.catch(error => {
						if (error instanceof CostCapError) session.reportCostCapRefusal(error.refusal);
					});
				}

				return stream;
			},

			transformToolCallArguments,
			// A stray sloppy payload in plain text becomes a real edit tool call so
			// the normal pipeline (validation, approval, rendering) executes it.
			transformAssistantMessage: async (message, signal) => {
				if (cfgEditRecoverInlineEdits.get(settings)) {
					// The live tool is an ExtensionToolWrapper whose proxy forwards the
					// EditTool `mode` getter; a bridge/custom edit tool without a sloppy
					// mode (e.g. Cursor's replace-pinned pi_edit) never recovers.
					const editTool = agent.state.tools.find(tool => tool.name === "edit") as { mode?: EditMode } | undefined;
					if (editTool?.mode === "sloppy") {
						const recovered = recoverInlineSloppyEdit(message);
						if (recovered > 0) {
							logger.info("recovered inline sloppy edit payload into edit tool call", { regions: recovered });
						}
					}
				}
				const content = await session?.extensionRunner?.emitAssistantMessage(message, signal);
				if (content) message.content = content;
			},
			// Recovery only fires on turns without tool calls and appends a new one,
			// so streamed calls (and their speculation sessions) are never rewritten.
			transformAssistantMessagePreservesToolCalls: true,
			resolveFallbackTool: resolveDeviceTool,
			suggestFallbackToolNames: suggestDeviceToolNames,
			intentTracing: cfgToolsIntentTracing.get(settings),
			pruneToolDescriptions: resolveInlineToolDescriptors(),

			speculativeToolExecution,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			onToolChoiceUnavailable: () => session?.toolChoiceQueue.reject("unavailable"),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(cfgProviderAppendOnlyContext.get(settings))
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		// Restore messages if session has existing data
		if (hasExistingSession) {
			const restored = existingSession;
			agent.replaceMessages(restored.messages);
			if (persistInitialServiceTier) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				const initialModel = `${model.provider}/${model.id}`;
				sessionManager.appendModelChange(initialModel);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			}
			if (persistInitialServiceTier || Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		}

		// Advisors share this session's extension runner (for the approval gate
		// below), so their tool calls must name the advisor as `ctx.agent`; the
		// runner's own identity would report them as this session's agent.
		const advisorAgent: ExtensionAgentIdentity = Object.freeze({
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: resolvedAgentId,
		});

		// Full toolset for the advisor, built unconditionally so it can be toggled at
		// runtime. Bound to a DISTINCT ToolSession (its own `-advisor` session id +
		// agent id) so the advisor's tool state — snapshot, seen-lines, conflict, and
		// summary caches, all keyed on session identity — stays isolated from the
		// primary, while edit/bash/write stay fully functional: the advisor is a full
		// agent and its config's `tools` selects which of these it actually gets
		// (defaulting to read/grep/glob).
		const advisorToolSession: ToolSession = {
			...toolSession,
			// The primary may carry a dormant xd:// write transport. Advisors use
			// their own configured tool slate, so a selected write is always full.
			deviceOnlyWrite: undefined,
			pendingFullWriteDescription: undefined,
			get cwd() {
				return sessionManager.getCwd();
			},
			get skillHintVisible() {
				return toolSession.skillHintVisible;
			},
			// Live, not the spread's copy: a rediscovery after a plugin upgrade replaces the primary's list.
			get skills() {
				return toolSession.skills;
			},
			hasEditTool: true,
			requireYieldTool: false,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			getAgentId: () => advisorAgent.id,
			// The primary's availability signals are wrong for advisors: their tool
			// slate is filtered separately at runtime (default read/grep/glob, no
			// write transport), so xd:// devices are unreachable. Images are inlined,
			// and the provider boundary handles text-only advisor models.
			xdev: undefined,
			isToolActive: name => toolSession.isToolActive?.(name) === true,
		};
		const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
		for (const name in BUILTIN_TOOLS) {
			advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
		}
		const built = await Promise.all(advisorToolBuilds);
		// Wrapped like every registry tool: `ExtensionToolWrapper` is where the
		// approval mode, per-tool `tools.approval.<tool>` policies and
		// `autoApprove` are enforced. The advisor's loop and its Cursor exec
		// bridge both run these instances directly, so a raw one would execute a
		// `bash`/`write` the user configured as `ask` or `deny`. Meta-notice
		// first, matching the registry's wrap order.
		const advisorTools: Tool[] = built
			.filter((tool): tool is Tool => tool != null)
			.map(tool => new ExtensionToolWrapper(wrapToolWithMetaNotice(tool), extensionRunner, advisorAgent) as Tool);

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (initialActiveRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(initialActiveRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the user's standing project rules instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		// Advisor spend recorded before this resume is restored off the critical
		// path below (issue #9553): a large advisor transcript would otherwise
		// block createAgentSession for tens of seconds while the whole file is
		// streamed and parsed on the main thread.
		session = new AgentSession({
			costGate: options.costGate,
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorSharedMaxNotesPerUpdate: discoveredAdvisors.sharedMaxNotesPerUpdate,
			advisorConfigs: discoveredAdvisors.advisors,
			advisorConfigWarnings: discoveredAdvisors.warnings,
			agent,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			thinkingLevelCeiling: options.thinkingLevelCeiling,
			awaitingAssignment: options.awaitingAssignment,
			planYolo: options.planYolo,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			settings,
			additionalExtensionPaths: options.additionalExtensionPaths,
			extensionRoots: buildSessionExtensionRoots,
			preparedExtensions: extensionsResult.preparedExtensions,
			extensionPaths,
			disableExtensionDiscovery: options.disableExtensionDiscovery,
			autoApprove: options.autoApprove,
			scoutAllowedBySpawnPolicy: isScoutSpawnable(undefined, options.spawns ?? "*"),
			evalKernelOwnerId,
			// Children borrow their parent's manager but never dispose it.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			inheritedSessionAgents: options.inheritedSessionAgents,
			promptTemplates,
			slashCommands,
			extensionRunner,
			getEvalPreludes,
			evalToolSession: toolSession,
			customCommands: customCommandsResult.commands,
			skills,
			skillDescriptions,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings: cfgSkills.get(settings),
			modelRegistry,
			allowSessionModelFallback: false,
			interactivePrompts: options.interactivePrompts,

			toolRegistry,
			createThinkTool: async () => (await HIDDEN_TOOLS.think(toolSession)) ?? null,
			createVibeTools:
				(options.taskDepth ?? 0) === 0 && !options.parentTaskPrefix
					? () => createVibeTools(toolSession)
					: undefined,
			builtInToolNames: builtInRegistryToolNames,
			mcpManagerToolNames: initialMcpManagerToolNames,
			transformContext,
			transformProviderContext,
			createAdvisorTransformProviderContext: () => createTransformProviderContext(),
			onPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			advisorStreamFn: settingsAwareStreamFn,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getXdevToolEntries: () => (toolSession.xdev ? xdevEntries(toolSession.xdev) : []),
			xdev: toolSession.xdev,
			presentationPinnedToolNames,
			setActiveToolNames: setSessionActiveToolNames,
			ensureWriteRegistered,
			isDeviceOnlyWrite: () => toolSession.deviceOnlyWrite === true,
			setDeviceOnlyWrite: enabled => {
				toolSession.deviceOnlyWrite = enabled ? true : undefined;
			},
			setPendingFullWriteDescription: enabled => {
				toolSession.pendingFullWriteDescription = enabled ? true : undefined;
			},
			ensureGoalRegistered,
			reconcileSettingsGatedTools,
			getMcpServerInstructions: () => {
				const raw = readMcpServerInstructions();
				if (!raw || raw.size === 0) return raw;
				const out = new Map<string, string>();
				for (const [name, text] of raw) {
					out.set(
						name,
						text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
					);
				}
				return out;
			},
			setMcpServerInstructionsSource: source => {
				hostMcpServerInstructions = source;
			},
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentKind,
			agentRegistry,
			providerSessionId: options.providerSessionId,

			providerPromptCacheKeySource,
			advisorTools,

			titleSystemPrompt: options.titleSystemPrompt,
			autoTitle: options.autoTitle === true && !isSubagentSession,
		});
		hasSession = true;
		// The session now owns its cost gate; the interactive TUI starts compression after its first frame.
		if (options.deferSkillDescriptionCompression !== true) skillDescriptions.startCompression();

		// Hashline snapshots are session-scoped: /new and switchSession fire the
		// change callbacks, so clear the tool-side store there — stale tags would
		// otherwise surface as "issued in this session" in mismatch diagnostics
		// after a reset (#13370). The tools snapshot into THIS store, not the
		// AgentSession's own lazy field.
		session.registerSessionChangeCallback(() => toolSession.editStore?.clear());
		if (ownedSkillDescriptionStore) {
			// Let in-flight compressions land before releasing the file.
			session.addDisposer(
				() => void skillDescriptions.waitForPending().finally(() => ownedSkillDescriptionStore.close()),
			);
		}

		// One coalesced prompt rebuild for every prompt input (rule bucketing, the
		// `tools.format` catalog dialect, personality, …), so a bulk change rebuilds once.
		// Hide Secrets first switches outbound obfuscation on the live obfuscator (earlier
		// placeholders keep deobfuscating, the first switch-on builds it): the prompt
		// reports its state.
		cfgSystemPromptInputs.listen(session, async (next, previous) => {
			if (next.secretsEnabled !== previous.secretsEnabled) {
				try {
					if (cfgSecretsEnabled.get(settings) && !obfuscator) {
						const built = await buildSecretObfuscator(cwd, agentDir, options.agentDir);
						if (!obfuscator && built) {
							obfuscator = built;
							session.setObfuscator(built);
						}
					}
					obfuscator?.setObfuscating(cfgSecretsEnabled.get(settings));
				} catch (error) {
					logger.warn("Hide Secrets change not applied", { error: String(error) });
				}
			}
			if (session.isDisposed) return;
			try {
				await session.refreshBaseSystemPrompt();
			} catch (error) {
				session.emitNotice("error", `Failed to rebuild the system prompt after a settings change: ${error}`);
			}
		});
		// Agent-level tool-call switches: the loop snapshots them per prompt run, so a
		// change applies from the next run without splitting one response's schema/strip.
		// The prompt listener above republishes the intent-field guidance.
		cfgToolCallSwitches.listen(session, ({ intentTracing }) => {
			agent.intentTracing = intentTracing;
		});
		// Tool-gating settings add or remove the tools they gate and refresh the
		// prompt once per coalesced change. Restricted (structured) sessions keep the
		// exact host-provided tool list they were built with.
		if (!restrictToolNames) {
			const reconcileGatedTools = async (options?: { refreshPrompt?: boolean }): Promise<void> => {
				try {
					await session.reconcileBuiltinTools(options);
				} catch (error) {
					session.emitNotice("error", `Failed to apply tool settings: ${error}`);
				}
			};
			cfgSessionToolGates.listen(session, () => reconcileGatedTools());
			// `find.enabled: auto` follows the judge role; a role change only touches
			// the prompt when it actually adds or removes `find`.
			cfgModel.listen(session, () => reconcileGatedTools({ refreshPrompt: false }));
		}
		// Backfill the resumed advisor spend without blocking startup: the scan
		// runs after the session is live, so `--resume` no longer scales with the
		// advisor transcript size (issue #9553).
		session.beginInitialAdvisorCostRestore();
		// Extension factories normally register tools before session construction,
		// but Pi-compatible extensions may discover them asynchronously from a
		// session_start handler. Install those late registrations into the live
		// registry and serialize activation so no update can overwrite a sibling.
		const scheduledToolRegistrations = new WeakMap<RegisteredTool, Promise<void>>();
		const scheduleToolRegistration = (registered: RegisteredTool, signal?: AbortSignal): Promise<void> => {
			const scheduled = scheduledToolRegistrations.get(registered);
			if (scheduled) return scheduled;
			const activationSignal = signal ?? AbortSignal.timeout(EXTENSION_HANDLER_TIMEOUT_MS);

			const [wrapped] = wrapRegisteredTools([registered], extensionRunner);
			if (!wrapped) return Promise.resolve();
			const name = registered.definition.name;
			const liveTool = new ExtensionToolWrapper(wrapToolWithMetaNotice(wrapped), extensionRunner);
			// Capture ordinary extension precedence while the listener observes this exact registration.
			// A later same-name registration may replace the extension map before serialized activation runs.
			const isEffectiveRegistrant = extensionRunner.getRegisteredTool(name) === registered;
			const activation = session.runToolRegistryMutation(async () => {
				activationSignal.throwIfAborted();
				const existingTool = toolRegistry.get(name);
				const previousExtensionMcpTool = session.getExtensionMCPTool(name);
				const wasMcpManagerTool = session.hasMCPManagerTool(name);
				if (existingTool) {
					// RPC host tools and SDK custom tools retain their startup precedence when an
					// extension registers the same name later.
					if (session.hasRpcHostTool(name) || sdkCustomToolNames.has(name)) return;
					// Put the replacement first so same-origin MCP re-registration keeps it. Distinct MCP origins still
					// use the stable winner; ordinary tool collisions retain the extension runner's last-wins precedence.
					const competingTools = deduplicateMCPToolsByName([liveTool, existingTool]);
					if (competingTools.length === 1) {
						if (competingTools[0] !== liveTool) return;
					} else if (!isEffectiveRegistrant) {
						return;
					}
				} else if (!isEffectiveRegistrant) {
					return;
				}

				const enabled = session.getEnabledToolNames();
				const alreadyEnabled = enabled.includes(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				const mounted = session.getMountedXdevToolNames();
				const wasBuiltIn = builtInRegistryToolNames.has(name);
				toolRegistry.set(name, liveTool);
				builtInRegistryToolNames.delete(name);
				session.setToolBuiltIn(name, false);
				session.setExtensionMCPTool(name, liveTool);
				try {
					if ((registered.definition.defaultInactive || registered.definition.hidden) && !explicitlyRequested) {
						if (!alreadyEnabled) return;
						await session.setActiveToolPresentation(
							enabled.filter(enabledName => enabledName !== name),
							mounted.filter(mountedName => mountedName !== name),
							existingTool !== undefined,
							activationSignal,
						);
						return;
					}
					// Re-registration refreshes the implementation, but it must not reverse an
					// explicit setActiveTools() decision that disabled the previous definition.
					if (existingTool && !alreadyEnabled) return;
					const shouldMount =
						!explicitlyRequested &&
						toolSession.xdev !== undefined &&
						builtInRegistryToolNames.has("read") &&
						builtInRegistryToolNames.has("write") &&
						enabled.includes("read") &&
						(enabled.includes("write") || toolSession.deviceOnlyWrite === true) &&
						isMountableUnderXdev(liveTool);
					const nextMounted = shouldMount
						? mounted.includes(name)
							? mounted
							: [...mounted, name]
						: mounted.filter(mountedName => mountedName !== name);
					await session.setActiveToolPresentation(
						alreadyEnabled ? enabled : [...enabled, name],
						nextMounted,
						existingTool !== undefined,
						activationSignal,
					);
				} catch (error) {
					if (existingTool) {
						toolRegistry.set(name, existingTool);
					} else {
						toolRegistry.delete(name);
					}
					if (wasBuiltIn) builtInRegistryToolNames.add(name);
					session.setToolBuiltIn(name, wasBuiltIn);
					session.setExtensionMCPTool(name, previousExtensionMcpTool);
					session.setMCPManagerTool(name, wasMcpManagerTool);
					throw error;
				}
			}, activationSignal);
			scheduledToolRegistrations.set(registered, activation);
			return activation;
		};
		if (!restrictToolNames) {
			const unsubscribeToolRegistrations = extensionRunner.onToolRegistered(scheduleToolRegistration);
			disposeCallbacks.add(unsubscribeToolRegistrations);

			// Close the construction race: a background registration can land after
			// the initial snapshot but before the live listener above is attached.
			for (const registered of extensionRunner.getAllRegisteredTools()) {
				if (!initialRegisteredTools.has(registered)) {
					await scheduleToolRegistration(registered);
				}
			}
		}
		if (agentKind === "main") {
			// Live skills/commands discovery settings: rediscover skills and file slash
			// commands, rebuild the prompt, and notify command pickers (TUI/RPC/ACP).
			// `enabledProviders`/`disabledProviders` gate foreign provider sources.
			cfgSkillsAndCommandsDiscovery.listen(session, () => session.refreshSkillsAndCommands());
			// Live `extensions` / `disabledExtensions`: a settings-governed extension whose
			// source leaves the rediscovered set is suspended (handlers, commands, tools,
			// renderers, shortcuts, file fallbacks) and a returning source resumes. Modules
			// are never unloaded, and sources this process never imported need a restart.
			// Governed = discoverable with every `extensions` entry seen this session and
			// nothing disabled; caller-preloaded and inline extensions are never touched.
			let extensionReconcile: Promise<void> = Promise.resolve();
			const announcedUnloadedExtensions = new Set<string>();
			const seenConfiguredExtensions = new Set(buildSessionExtensionRoots().configured);
			const reconcileExtensionSources = async (): Promise<void> => {
				const roots = buildSessionExtensionRoots();
				// Explicit-only sessions (`--no-extensions`, trusted allowlists) ignore both settings.
				if (roots.mode === "explicit-only") return;
				for (const configured of roots.configured) seenConfiguredExtensions.add(configured);
				resetCapabilities();
				const cwdNow = sessionManager.getCwd();
				const [governedPaths, enabledPaths] = await Promise.all([
					discoverExtensionPaths([...roots.explicit, ...seenConfiguredExtensions], cwdNow, []),
					discoverSessionExtensionPaths({ extensionRoots: () => roots }, cwdNow, settings),
				]);
				const governed = new Set(governedPaths.map(extensionPath => resolvePath(extensionPath, cwdNow)));
				const enabled = new Set(enabledPaths.map(extensionPath => resolvePath(extensionPath, cwdNow)));
				const { suspended, resumed } = extensionRunner.setSuspendedExtensions(
					extension => governed.has(extension.resolvedPath) && !enabled.has(extension.resolvedPath),
				);
				const loadedPaths = new Set(extensionRunner.getLoadedExtensions().map(extension => extension.resolvedPath));
				const unloaded = [...enabled].filter(
					extensionPath => !loadedPaths.has(extensionPath) && !announcedUnloadedExtensions.has(extensionPath),
				);
				if (unloaded.length > 0) {
					for (const extensionPath of unloaded) announcedUnloadedExtensions.add(extensionPath);
					session.emitNotice(
						"warning",
						`Restart omp to load newly enabled extensions: ${unloaded.join(", ")}`,
						"extensions",
					);
				}
				if (restrictToolNames) return;
				const suspendedToolNames = new Set(suspended.flatMap(extension => [...extension.tools.keys()]));
				const resumedToolNames = new Set(resumed.flatMap(extension => [...extension.tools.keys()]));
				for (const name of new Set([...suspendedToolNames, ...resumedToolNames])) {
					// RPC host, SDK custom, and MCP manager tools keep precedence over extension tools.
					if (session.hasRpcHostTool(name) || sdkCustomToolNames.has(name) || session.hasMCPManagerTool(name)) {
						continue;
					}
					const effective = extensionRunner.getRegisteredTool(name);
					if (effective) {
						// Re-run activation for the surviving registrant, bypassing the once-per-tool cache.
						scheduledToolRegistrations.delete(effective);
						await scheduleToolRegistration(effective);
						continue;
					}
					if (!suspendedToolNames.has(name)) continue;
					await session.runToolRegistryMutation(async () => {
						const enabled = session.getEnabledToolNames();
						const mounted = session.getMountedXdevToolNames();
						const native = nativeToolsByName.get(name);
						session.setExtensionMCPTool(name, undefined);
						if (native) {
							// The suspended extension overrode a built-in: restore the native tool.
							toolRegistry.set(name, new ExtensionToolWrapper(native, extensionRunner));
							builtInRegistryToolNames.add(name);
							session.setToolBuiltIn(name, true);
							await session.setActiveToolPresentation(enabled, mounted, true);
							return;
						}
						toolRegistry.delete(name);
						await session.setActiveToolPresentation(
							enabled.filter(enabledName => enabledName !== name),
							mounted.filter(mountedName => mountedName !== name),
						);
					});
				}
			};
			cfgExtensionSources.listen(session, () => {
				const next = extensionReconcile
					.catch(() => {})
					.then(reconcileExtensionSources)
					.then(() => session.refreshSkillsAndCommands());
				extensionReconcile = next;
				return next;
			});
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
			build: buildLateDiagnosticsBatchMessage,
			isStale: entry => entry.isStale(),
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		if (
			!registeredAgentRef ||
			!agentRegistry.attachSession(
				resolvedAgentId,
				session,
				sessionManager.getSessionFile() ?? null,
				registeredAgentRef,
			) ||
			!agentRegistry.setStatus(resolvedAgentId, "running", registeredAgentRef)
		) {
			throw new Error(`Agent "${resolvedAgentId}" was replaced during session initialization.`);
		}
		hasRegistered = true;
		// MCP notification bridge cleanup — assigned when the bridge is wired below,
		// invoked from the dispose wrapper AND registered as a postmortem so both
		// explicit-dispose (SDK embedders that reuse the process across sessions) and
		// process-exit paths tear the listener down. Nulled after use so the closure
		// graph (`extensionRunner`, `session`) can be GC'd instead of retained by the
		// process-global postmortem list.
		let unsubscribeMcpNotifications: (() => void) | undefined;
		let unregisterMcpPostmortem: (() => void) | undefined;

		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async (disposeOptions?: AgentSessionDisposeOptions) => {
				try {
					// Reject new session work (eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						const vibeRegistry = VibeSessionRegistry.global();
						const vibeParentSession = {
							getAgentId: () => resolvedAgentId,
							getSessionId: () => sessionManager.getSessionId(),
							getSessionFile: () => sessionManager.getSessionFile() ?? null,
							sessionManager,
							asyncJobManager: scopedAsyncJobManager,
							settings,
							getActiveModelString,
						};
						await vibeRegistry.suspendScope(vibeRegistry.ownerScope(vibeParentSession), scopedAsyncJobManager);
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose(disposeOptions);
				} finally {
					unregisterUnlessParked();

					unbindSessionEffects?.();
					restoreProviderToggles?.();
					unsubscribeMcpNotifications?.();
					unregisterMcpPostmortem?.();
					for (const callback of disposeCallbacks) callback();
					disposeCallbacks.clear();
					// Drop refs so the process-global postmortem list doesn't retain
					// the bridge closure past explicit dispose.
					unsubscribeMcpNotifications = undefined;
					unregisterMcpPostmortem = undefined;
				}
			};
		}

		// Broker-shared language servers (see lsp/mux/protocol.ts). The mode is
		// process state read on every client cold start, so only a session that binds
		// process state holds it, until disposed. A subagent or helper session (usually
		// enableLsp=false) must not switch the parent's later cold starts to private
		// servers. Re-applied live on `lsp.shared` changes; running clients keep
		// their transport until they exit or idle out.
		if (bindsProcessState) {
			const sharedLsp = holdSharedLsp(enableLsp && cfgLspShared.get(settings));
			disposeCallbacks.add(sharedLsp.release);
			if (enableLsp) {
				cfgLspShared.listen(session, shared => sharedLsp.set(shared));
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the lsp tool or an edit/write
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		// Turning `lsp.lazy` off mid-session kicks off the same warmup once.
		// `lsp.enabled: false` skips discovery and warmup entirely; `lspServers` stays undefined.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && cfgLspEnabled.get(settings) && options.hasUI) {
			const startupLspServers = discoverStartupLspServers(
				cwd,
				cfgLspLazy.get(settings) ? "available" : "connecting",
			);
			lspServers = startupLspServers;
			let lspWarmupStarted = false;
			const startLspWarmup = () => {
				if (lspWarmupStarted || startupLspServers.length === 0) return;
				lspWarmupStarted = true;
				for (const server of startupLspServers) server.status = "connecting";
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of startupLspServers) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						if (!cfgStartupQuiet.get(settings)) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of startupLspServers) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						if (!cfgStartupQuiet.get(settings)) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			};
			if (cfgLspLazy.get(settings)) {
				cfgLspLazy.listen(session, lazy => {
					if (!lazy) startLspWarmup();
				});
			} else {
				startLspWarmup();
			}
		}

		// MCP manager wiring has two ownership models:
		//   * Single-slot callbacks (tools/prompts/resources changed) — exactly one
		//     owner per manager. When reusing a parent's manager (subagent path,
		//     see task/executor.ts), the parent already owns these slots so we
		//     MUST NOT overwrite them. Guarded by `!options.mcpManager`.
		//   * Notification listener — multi-listener by design. Every session with
		//     an MCP manager (fresh OR reused) needs its own bridge to its own
		//     `extensionRunner` so extensions loaded in that session receive frames.
		//     Guarded only by `mcpManager` (see the second `if` below).
		if (ownedMcpManager) {
			const ownedManager = ownedMcpManager;
			ownedMcpManager.setOnToolsChanged(async tools => {
				try {
					await session.refreshMCPTools(tools);
				} catch (error) {
					logger.warn("MCP tool refresh failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			ownedMcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(ownedManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			// Cancel on dispose: the process-global postmortem list would otherwise pin
			// this closure's scope (and with it the whole session) forever.
			const unregisterDebounceCleanup = postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			disposeCallbacks.add(() => {
				clearDebounceTimers();
				unregisterDebounceCleanup();
			});
			ownedMcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!cfgMcpNotifications.get(settings)) return;
				const debounceMs = cfgMcpNotificationDebounceMs.get(settings);
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!cfgMcpNotifications.get(settings)) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
			// Live resource subscribe/unsubscribe as `mcp.notifications` flips.
			cfgMcpNotifications.listen(session, enabled => ownedManager.setNotificationsEnabled(enabled));
		}

		if (mcpManager) {
			// Bridge server-initiated notifications to this session's extension
			// handlers. Multi-listener registration: fresh-manager and reused-manager
			// sessions both install their own listener here, so a subagent's
			// extensions get frames even though the parent owns the single-slot
			// tool/prompt/resource callbacks above. MCPManager fires known
			// list/update refreshes internally, then invokes all registered
			// listeners with (server, method, params) for every frame (including
			// server-custom methods). Two-layer buffering protects the startup
			// race: MCPManager buffers frames received before the first
			// `addNotificationListener` subscriber (drains here); ExtensionRunner
			// buffers frames received before `initialize()` and drains them on
			// init. Both drop-oldest under pressure at cap 100.
			unsubscribeMcpNotifications = mcpManager.addNotificationListener((server, method, params) => {
				void extensionRunner.emitMcpNotification({ server, method, params });
			});
			// postmortem.register returns a cancel function; capture it so explicit
			// session.dispose can remove this from the global list (see finally above).
			unregisterMcpPostmortem = postmortem.register("mcp-notification-listener-cleanup", () =>
				unsubscribeMcpNotifications?.(),
			);
		}

		if (ownedMcpManager) {
			// The owning session keeps project `.mcp.json` servers in step with
			// `mcp.enableProjectConfig` without a `/mcp reload`.
			const ownedMCPManager = ownedMcpManager;
			const owningSession = session;
			cfgMcpEnableProjectConfig.listen(owningSession, async enabled => {
				if (owningSession.isDisposed) return;
				await ownedMCPManager.reconcileProjectConfig(enabled);
				if (owningSession.isDisposed) return;
				await owningSession.refreshMCPTools(ownedMCPManager.getTools());
			});
		}

		if (ownedMcpManager && !deferMCPDiscoveryForUI) {
			const currentMcpManagerTools = ownedMcpManager.getTools();
			let sameMcpManagerTools = currentMcpManagerTools.length === initialMcpManagerTools.length;
			for (let i = 0; sameMcpManagerTools && i < currentMcpManagerTools.length; i++) {
				sameMcpManagerTools = currentMcpManagerTools[i] === initialMcpManagerTools[i];
			}
			if (!sameMcpManagerTools) {
				await session.refreshMCPTools(currentMcpManagerTools);
			}
		}

		if (deferredExtensionPaths.length > 0) {
			const forwardedPreparedExtensions = extensionsResult.preparedExtensions ?? [];
			const runtime = extensionsResult.runtime;
			session.setDeferredExtensionLoader(async () => {
				const loaded = await logger.time(
					"loadDeferredExtensions",
					loadExtensions,
					[...deferredExtensionPaths],
					cwd,
					eventBus,
					runtime,
				);
				const storage = settings.getStorage();
				if (storage) await recordStartupVerdicts(storage, loaded.extensions);
				for (const { path, error } of loaded.errors) logger.error("Failed to load extension", { path, error });
				for (const message of formatExtensionLoadNotifications(loaded.errors)) {
					session.emitNotice("warning", message, "extensions");
				}
				if (session.isDisposed) return;
				// Providers queue until the runner is initialized; drain them as session creation does.
				for (const { name, config, sourceId } of runtime.pendingProviderRegistrations.splice(0)) {
					modelRegistry.registerProvider(name, config, sourceId);
				}
				forwardedPreparedExtensions.push(...(loaded.preparedExtensions ?? []));
				extensionPaths.push(...loaded.extensions.map(extension => extension.resolvedPath));
				await extensionRunner.addExtensions(loaded.extensions);
			});
		}
		startDeferredMCPDiscovery?.(session);

		startupCleanup.move();
		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager: ownedMcpManager ?? (mcpManager instanceof MCPManager ? mcpManager : undefined),
			modelFallbackMessage,
			lspServers,

			eventBus,
			subagentEventBus,
		};
	} catch (error) {
		try {
			if (hasSession) {
				await session.dispose();
				if (hasRegistered) unregisterUnlessParked();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeVmContextsByOwner(evalKernelOwnerId);
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}
