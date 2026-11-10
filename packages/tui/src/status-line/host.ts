import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Tool } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { JobWidgetEntry } from "../tools/job-widget";
import type { CompactionBoundaries } from "./context-usage";
import type { StatusLineSettings } from "./types";

/** Nested repository selected as the active workspace context. */
export interface ActiveRepoContext {
	cwd: string;
	repoRoot: string;
	relativeRepoRoot: string;
	source: "single-direct-child-repo";
}

export interface StatusLineSession {
	state: { model?: Model; thinkingLevel?: ThinkingLevel; messages: readonly AgentMessage[] };
	model?: Model;
	messages?: readonly AgentMessage[];
	sessionFile?: string;
	isStreaming: boolean;
	isAutoThinking: boolean;
	contextUsageRevision?: number;
	systemPrompt?: readonly string[];
	agent?: { state?: { tools?: readonly Pick<Tool, "name" | "description" | "parameters">[] }; tokenizer?: unknown };
	skills?: readonly unknown[];
	compactionSpeculation?: "idle" | "running" | "armed";
	sessionManager: {
		getSessionName(): string | undefined;
		getSessionId(): string;
		getUsageStatistics(): {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			orchestrationInput: number;
			orchestrationOutput: number;
			orchestrationCacheRead: number;
			premiumRequests: number;
			cost: number;
			/** Portion of `cost` carried by completed subagent task results. */
			subagentCost?: number;
		};
	};
	getContextUsage(): { tokens: number; contextWindow: number; percent: number | null } | undefined;
	autoResolvedThinkingLevel(): string | undefined;
	isFastModeActive(): boolean;
	getAsyncJobSnapshot(): { running: readonly { type: string; agentId?: string }[] } | null | undefined;
	/** Widgets of the running background jobs, in job order; the jobs segment appends the freshest one's glance. */
	getRunningJobWidgets?(): readonly JobWidgetEntry[];
	getGoalModeState(): { goal?: { status: string; tokensUsed: number; tokenBudget?: number } } | undefined;
	getAdvisorStatusOverview?(): { configured: boolean; advisors: readonly { status: string; yielded: boolean }[] };
	getAdvisorCost?(): number;
}

export interface FooterSession {
	state: Pick<StatusLineSession["state"], "model" | "thinkingLevel">;
	isAutoThinking: boolean;
	autoResolvedThinkingLevel(): string | undefined;
	getContextUsage: StatusLineSession["getContextUsage"];
	/**
	 * Cumulative session rollup. Unlike the active-window stats it spans every
	 * entry in the session, so compaction does not reset the counters, and it
	 * folds in usage carried by completed `task` tool results.
	 */
	sessionManager: { getUsageStatistics: StatusLineSession["sessionManager"]["getUsageStatistics"] };
}

/**
 * Runtime services stay in the host; renderers only consume these capabilities.
 * `TSession` is the host's concrete session type (a structural superset of {@link StatusLineSession}).
 */
export interface StatusLineHost<TSession extends StatusLineSession = StatusLineSession> {
	getSettings(): StatusLineSettings;
	gitEnabled(): boolean;
	getSettingsRevision(): number;
	getSessionSettingsIdentity(session: TSession): unknown;
	getSessionSettingsRevision(session: TSession): number;
	goalStatusInFooter(session: TSession): boolean;
	resolveActiveRepo(cwd: string): ActiveRepoContext | null;
	lookupPullRequest(cwd: string): Promise<{ stdout: string; exitCode: number }>;
	calculateTokensPerSecond(messages: readonly AgentMessage[], isStreaming: boolean): number | null;
	computeCompactionBoundaries(session: TSession, contextWindow: number, model?: Model): CompactionBoundaries | null;
}

export interface FooterHost {
	gitEnabled(): boolean;
}
