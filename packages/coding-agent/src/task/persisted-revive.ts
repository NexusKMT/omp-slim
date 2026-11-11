import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import { inheritedModelGuard } from "./model-inheritance";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import type { AsyncJobManagerApi } from "../async";
import type { PreparedExtension } from "../extensibility/extensions/types";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { ArtifactManagerApi } from "../session/artifacts";
import type { CostGateApi } from "../session/cost-gate";
import type { AuthStorage } from "../session/auth-storage";
import { revivePersistedPlaced } from "../thread/executor-routing";
import { subagentWorkerPool } from "../thread/subagent-worker";
import {
	extractSessionInit,
	hasConversationalHistory,
	type PersistedSessionInit,
	SessionManager,
} from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import {
	attachIrcWakeTurnMonitor,
	compactionThresholdSettings,
	createSubagentSettings,
	followMCPTools,
	replayRevivedAgentStart,
	softRequestBudgetFor,
} from "./executor";
import { isCompletionProbeEnabled } from "./completion-probe";
import { type RestoredSeanceSession, restoreSeanceSession } from "./seance";
import { seanceIsolationOptions } from "./seance-policy";
import type { AgentDefinition } from "./types";

/**
 * Ambient context the reviver needs at revive time. The top-level session is
 * kept LIVE (cwd / artifact manager read on demand) so a later `/new` or cwd
 * move is followed rather than snapshotted; auth/models/settings are
 * process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
	/**
	 * Shared event bus feeding RPC/collab subagent subscriptions. Passed through
	 * to the wake-turn monitor so an IRC send to a cold-revived subagent emits
	 * the same lifecycle/progress frames a live run does.
	 */
	eventBus?: EventBus;
	/** Root-scoped observability bus the revived run's frames also publish to. */
	subagentEventBus?: EventBus;
}

/**
 * Everything one cold revive of a persisted subagent needs, built on main per revive and
 * cloneable (live objects cross as their bridged proxies), so the session can be created
 * on main or inside a pooled worker alike.
 */
export interface PersistedReviveSpec {
	readonly id: string;
	readonly displayName: string;
	readonly parentId: string | undefined;
	readonly sessionFile: string;
	/** Depth derived from the persisted parent chain (drives capability gating). */
	readonly taskDepth: number;
	/** The consulted source of a persisted seance session. */
	readonly restoredSeance: RestoredSeanceSession | undefined;
	/** The live top-level session revived agents join (cwd, extension roots, parent grants). */
	readonly root: AgentSessionHandle;
	/** Registry id of {@link root}. */
	readonly rootAgentId: string;
	readonly costGate: CostGateApi;
	readonly asyncJobManager: AsyncJobManagerApi | undefined;
	/** The root's artifact manager at revive time; a revived non-seance agent adopts it. */
	readonly artifactManager: ArtifactManagerApi | undefined;
	readonly preparedExtensions: readonly PreparedExtension[] | undefined;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settings: Settings;
	readonly enableLsp: boolean;
	readonly eventBus: EventBus | undefined;
	readonly subagentEventBus: EventBus | undefined;
}

/**
 * Durable agent definition name (`scout`, `reviewer`, …) of a persisted subagent.
 * Cold-revived refs register with `displayName: id` (`registry/persisted-agents.ts`),
 * so a generated task id would silently drop agent-scoped rules and budgets.
 * `init.agent` carries the real name; only files predating that field fall back to
 * `displayName`. A parked transcript may also predate the `main`/`sub` definition-name
 * reservation (`discovery/helpers.ts`): a persisted `init.agent` of either sentinel
 * value from such a legacy custom agent must not masquerade as that sentinel, so it
 * falls back to `displayName` too, keeping it scoped as an ordinary subagent under its
 * generated id instead of `main` or the shared `sub` bucket.
 */
export function persistedAgentName(displayName: string, init: PersistedSessionInit): string {
	const normalized = init.agent?.trim().toLowerCase();
	return init.agent && normalized !== MAIN_AGENT_RULE_NAME && normalized !== SUB_AGENT_RULE_NAME
		? init.agent
		: displayName;
}

/**
 * The agent definition a cold-revived subagent's monitored turns report (IRC wakes,
 * `omp --restore`): persisted files predate an agent-source field, so frames carry
 * the runtime-neutral `user` source; the name is the registry ref's.
 */
export function persistedAgentDefinition(displayName: string, init: PersistedSessionInit): AgentDefinition {
	return {
		name: displayName,
		description: "",
		systemPrompt: init.systemPrompt.join("\n\n"),
		source: "user",
	};
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP proxy tools, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		let restoredSeance: RestoredSeanceSession | undefined;
		if (peek.seanceSource !== undefined) {
			try {
				restoredSeance = await restoreSeanceSession({
					init: peek.init,
					cwd: peek.cwd,
					modelRegistry: ctx.modelRegistry,
				});
			} catch (error) {
				logger.warn("Unable to restore persisted seance session", {
					sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
			if (!restoredSeance) return undefined;
		}
		// Isolated runs are never resumable: their worktree is merged + cleaned,
		// and the parent was told messaging is impossible. A retained workspace
		// (capture/persist failure) still exists on disk and would pass the cwd
		// probe below, so gate on the stamped contract instead — otherwise a
		// restart + peer message revives the agent outside isolation, in the
		// parent cwd, contradicting the delivery notice.
		if (peek.init.isolated) return undefined;
		try {
			await fs.stat(restoredSeance?.cwd ?? peek.cwd);
		} catch {
			return undefined;
		}
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		return async expectedRef => {
			// Live root state is read per revive, so a later `/new` or cwd move is followed.
			const spec: PersistedReviveSpec = {
				id: ref.id,
				displayName: ref.displayName,
				parentId: ref.parentId,
				sessionFile,
				taskDepth,
				restoredSeance,
				root: ctx.session,
				rootAgentId: ctx.session.getAgentId?.() ?? MAIN_AGENT_ID,
				costGate: ctx.session.costGate,
				asyncJobManager: ctx.session.asyncJobManager,
				artifactManager: ctx.session.sessionManager.getArtifactManager() ?? undefined,
				preparedExtensions: ctx.session.preparedExtensions,
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				settings: ctx.settings,
				enableLsp: ctx.enableLsp,
				eventBus: ctx.eventBus,
				subagentEventBus: ctx.subagentEventBus,
			};
			// Worker mode: a revival is placed like a fresh spawn (main thread or a worker).
			const pool = subagentWorkerPool(ctx.settings);
			return pool
				? revivePersistedPlaced(pool, spec, expectedRef, revivePersistedSubagent)
				: revivePersistedSubagent(spec, expectedRef);
		};
	};
}

/**
 * Rebuild the persisted subagent of `spec` on the calling thread (main, or the pooled
 * worker that will home it) and claim `expectedRef` for it.
 */
export async function revivePersistedSubagent(spec: PersistedReviveSpec, expectedRef: AgentRef): Promise<AgentSession> {
	const ref = { id: spec.id, displayName: spec.displayName, parentId: spec.parentId };
	const { sessionFile, taskDepth, restoredSeance } = spec;
	const seanceOptions = restoredSeance ? seanceIsolationOptions(restoredSeance.cwd) : {};
	const registry = AgentRegistry.global();
	// Re-open fresh on every revive: park closes the writer, so this takes
	// the single-writer lock cleanly and restores the full message history.
	const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	const entries = reopened.getEntries();
	const init = extractSessionInit(entries);
	if (!init) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no persisted session contract. The agent was not revived.`,
		);
	}
	if (!hasConversationalHistory(entries)) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no message history (truncated to header/session_init). The agent was not revived.`,
		);
	}
	const resolveParentSession = () =>
		ref.parentId === spec.rootAgentId ? spec.root : registry.get(ref.parentId ?? "")?.session;
	const parentSession = resolveParentSession();
	const model = parentSession?.model ?? spec.root.model;
	if (!model) {
		await reopened.close();
		throw new Error(`Cannot revive subagent "${ref.id}": the parent has no active model.`);
	}
	const subagentSettings = createSubagentSettings(spec.settings, {
		...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
		...(init.advisor ? { "advisor.enabled": true } : undefined),
		...compactionThresholdSettings(init.compactionThreshold),
	});
	// Account pools are owner policy, like the extension roots below: take the
	// live exact-name `task.agentAccountPools` entry, never a transcript copy.
	// Historical model/role fields remain readable but cannot select a new model.
	// Keep the original tool grants, including the read-only boundary.
	const revivedToolNames = restoredSeance
		? restoredSeance.toolNames
		: init.readOnly === true && init.tools.includes("write")
			? init.tools.filter(name => name !== "write")
			: init.tools;
	const artifactManager = spec.artifactManager;
	if (artifactManager && !restoredSeance) reopened.adoptArtifactManager(artifactManager);
	// A restricted persisted contract must not consult process-global MCP
	// state: same-name MCP tools are untrusted capability sources.
	const restrictToolNames = restoredSeance !== undefined || init.restrictToolNames === true;
	// The spawn's result contract: a session persisted without `yield` returned its final message.
	const structured = revivedToolNames.includes("yield");
	const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
	// Subscribe before minting proxies so a manager change during startup is replayed on bind.
	// The revived session reopens its own view, keeping the tools its earlier requests rendered.
	const mcpFollower = mcpManager ? followMCPTools(mcpManager, { scope: reopened.getSessionId() }) : undefined;
	const mcpProxyTools = mcpFollower?.proxyTools() ?? [];

	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: restoredSeance?.cwd ?? spec.root.sessionManager.getCwd(),
			costGate: spec.costGate,
			authStorage: spec.authStorage,
			// Revived agents join the root session tree, so their observability
			// frames ride the same bus the RPC/collab surfaces subscribed to.
			subagentEventBus: spec.subagentEventBus,
			modelRegistry: spec.modelRegistry,
			model,
			settings: subagentSettings,
			sessionManager: reopened,
			agentId: ref.id,
			agentDisplayName: ref.displayName,
			// `agents` rule scoping keys on the durable definition name (see `persistedAgentName`).
			agentName: persistedAgentName(ref.displayName, init),
			parentTaskPrefix: ref.id,
			asyncJobManager: spec.asyncJobManager,
			parentAgentId: ref.parentId,
			assertDispatchModel: inheritedModelGuard(model),
			expectedAgentRef: expectedRef,
			taskDepth,
			toolNames: revivedToolNames,
			// `revivedToolNames` is the enabled set, devices included: keep those devices,
			// or they come back as top-level tools and change the replayed tool list.
			mountedToolNames: restoredSeance ? undefined : init.mountedTools,
			outputSchema: init.outputSchema,
			outputSchemaMode: init.outputSchemaMode,
			restrictToolNames: restrictToolNames || undefined,
			requireYieldTool: structured,
			systemPrompt: () => [...init.systemPrompt],
			// Inherit current owner policy, never extension authority from a transcript.
			extensionRoots: () => spec.root.effectiveExtensionRoots,
			preloadedPreparedExtensions: spec.preparedExtensions,
			// Old files predate persisted spawns: deny re-spawning rather than let
			// createAgentSession default to wildcard ("*").
			spawns: init.spawns ?? "",
			hasUI: false,
			enableLsp: restrictToolNames ? false : spec.enableLsp,
			...(restrictToolNames
				? {
						enableIrc: false,
						enableMCP: false,
						preloadedExtensionPaths: [],
						preloadedCustomToolPaths: [],
					}
				: {
						enableMCP: !mcpManager,
						mcpManager,
						mcpTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						mcpToolScope: mcpFollower?.scope,
					}),
			...seanceOptions,
		}));
	} catch (error) {
		mcpFollower?.dispose();
		throw error;
	}
	mcpFollower?.bind(session);
	// Clamp the active set to the persisted list: createAgentSession's
	// `alwaysInclude` can re-add non-defaultInactive extension/custom tools
	// the original run didn't carry. Unknown/missing names are ignored.
	await session.setActiveToolsByName(
		restoredSeance ? revivedToolNames : [...revivedToolNames, ...session.getMountedXdevToolNames()],
	);
	// The yield tool's schema carries the last batch's items; the replayed prefix must match it.
	if (init.workPoolYieldItems) await session.setWorkPoolYieldItems(init.workPoolYieldItems);
	// Wire the extension runtime exactly as the live executor does. Without
	// this the runner stays pre-init, every action method throws
	// `ExtensionRuntimeNotInitializedError`, and a `tool_call` handler that
	// touches a runtime action trips the fail-closed gate in `emitToolCall`,
	// blocking every tool — including the hidden `yield` — in the revived
	// agent. `session_start` also re-runs so extensions restore per-session
	// state (issue #8824).
	await initializeExtensions(session, {
		reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
		reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
	});
	await replayRevivedAgentStart(session);
	// Cold revives must drive registry status themselves — createAgentSession
	// doesn't wire this generically (the live path does it in the executor).
	// The internal run-state signal precedes deferrable public `agent_end`,
	// keeping idle-TTL ownership synchronized even while prompts unwind.
	registry.syncSessionStatus(ref.id, session);
	attachIrcWakeTurnMonitor(session, {
		id: ref.id,
		agent: persistedAgentDefinition(ref.displayName, init),
		completionProbe: isCompletionProbeEnabled(spec.settings, taskDepth - 1),
		...softRequestBudgetFor(persistedAgentName(ref.displayName, init), spec.settings),
		eventBus: spec.eventBus,
		subagentEventBus: spec.subagentEventBus,
		sessionFile,
		structured,
		outputSchema: init.outputSchema,
		outputSchemaMode: init.outputSchemaMode,
		// Anchor artifacts to the revived ref's own dir (its parent's children
		// dir), not the live root session's, matching the spawn callers (#11563).
		artifactsDir: path.dirname(sessionFile),
	});
	return session;
}
