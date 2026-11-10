import { isRecord } from "@oh-my-pi/pi-utils";
import { combine, effect, register, type SettingValueOf } from "../config/registry";
import {
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "../config/service-tier";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, MAX_WEB_SEARCH_TIMEOUT_SECONDS } from "../web/search/types";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";

const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["wait"];

/** Scope of the resume picker's current-folder list. */
export const cfgSessionWorktreeScope = register({
	id: "session.worktreeScope",
	type: "enum",
	values: ["directory", "repo"] as const,
	default: "repo",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Resume Worktree Scope",
		description:
			"Choose whether the resume picker's current folder includes sessions from other repository worktrees",
		options: [
			{ value: "directory", label: "This Directory", description: "Only sessions saved for this directory" },
			{ value: "repo", label: "Repository Worktrees", description: "Also include sessions from sibling worktrees" },
		],
	},
});

// Power assertions: macOS IOKit, Linux login1/ScreenSaver, Windows execution state.
export const cfgPowerSleepPrevention = register({
	id: "power.sleepPrevention",
	type: "enum",
	values: ["off", "idle", "display", "system"] as const,
	default: "idle",
	ui: {
		tab: "interaction",
		group: "Power",
		label: "Sleep Prevention",
		description:
			"Prevent the system sleeping while the agent is running a turn; an idle session, including one waiting on background jobs, does not hold it. Each level is cumulative — it adds the flags of all lower levels.",
		options: [
			{
				value: "off",
				label: "Off",
				description: "Do not prevent any sleep",
			},
			{
				value: "idle",
				label: "Prevent Idle Sleep",
				description: "Keep the system awake while the agent is running a turn (macOS `caffeinate -i`)",
			},
			{
				value: "display",
				label: "Prevent Display Sleep",
				description: "Also keep the display from idle-sleeping (macOS `caffeinate -i -d`)",
			},
			{
				value: "system",
				label: "Prevent System Sleep",
				description:
					"Also block all system sleep on AC and declare the user active (macOS `caffeinate -i -d -s -u`)",
			},
		],
	},
});

function isPositiveLimit(limit: unknown): limit is number {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/** Per-provider request limits floored to whole numbers ≥ 1; non-positive or non-numeric entries are dropped. */
export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	const normalized: Record<string, number> = {};
	if (!isRecord(value)) return normalized;
	for (const provider in value) {
		const limit = value[provider];
		if (isPositiveLimit(limit)) normalized[provider] = Math.max(1, Math.floor(limit));
	}
	return normalized;
}

/**
 * Per-provider request limits floored to whole numbers ≥ 1.
 *
 * @throws Error naming every provider whose limit is not a positive number.
 */
export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (isRecord(value)) {
		const invalidProviders: string[] = [];
		for (const provider in value) if (!isPositiveLimit(value[provider])) invalidProviders.push(provider);
		if (invalidProviders.length > 0) {
			throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
		}
	}
	return normalizeProviderMaxInFlightRequests(value);
}

export const cfgProvidersMaxInFlightRequests = register({
	id: "providers.maxInFlightRequests",
	type: "record",
	default: EMPTY_NUMBER_RECORD,
	validate: validateProviderMaxInFlightRequests,
	normalize: validateProviderMaxInFlightRequests,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Max In-Flight Requests",
		description:
			'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited.',
	},
});
effect(cfgProvidersMaxInFlightRequests, limits =>
	configureProviderMaxInFlightRequests(normalizeProviderMaxInFlightRequests(limits)),
);

// ────────────────────────────────────────────────────────────────────────
// Model
// ────────────────────────────────────────────────────────────────────────

// Reasoning and prompts
export const cfgDefaultThinkingLevel = register({
	id: "defaultThinkingLevel",
	type: "enum",
	values: [...THINKING_EFFORTS, AUTO_THINKING],
	default: "high",
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Thinking Level",
		description: "Reasoning depth for thinking-capable models",
		options: [getConfiguredThinkingLevelMetadata(AUTO_THINKING), ...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
	},
});

export const cfgHideThinkingBlock = register({
	id: "hideThinkingBlock",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Hide Thinking Blocks",
		description: "Hide thinking blocks in assistant responses",
	},
});

export const cfgExpandThinkingBlocks = register({
	id: "expandThinkingBlocks",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Expand Thinking Blocks",
		description: "Keep finished thinking blocks expanded instead of collapsing them when the turn ends",
		condition: "nativeRendering",
	},
});

export const cfgProseOnlyThinking = register({
	id: "proseOnlyThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Prose Only Thinking",
		description: "Omit code blocks from thinking summaries and replace them with an ellipsis",
	},
});

export const cfgOmitThinking = register({
	id: "omitThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Omit Thinking summaries",
		description: "Instruct upstream providers to completely omit thinking summaries from responses (where supported)",
	},
});

export const cfgExternalThinking = register({
	id: "externalThinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "External Thinking",
		description: "Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning",
		warning: "At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement",
	},
});

export const cfgModelLoopGuardEnabled = register({
	id: "loopGuard.enabled",
	type: "boolean",
	default: true,
	// Kill switch shared with pi-ai's stream-level guard (`utils/thinking-loop.ts`); only `1` disables.
	env: { name: "PI_NO_THINKING_LOOP_GUARD", parse: raw => (raw === "1" ? false : undefined) },
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Loop Guard",
		description: "Enable automatic stream loop detection for model reasoning and prose",
	},
});

export const cfgModelLoopGuardCheckAssistantContent = register({
	id: "loopGuard.checkAssistantContent",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Loop Guard Scan Prose",
		description: "Apply loop guard to assistant prose messages in addition to thinking logs",
	},
});

export const cfgModelLoopGuardToolCallReminder = register({
	id: "loopGuard.toolCallReminder",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Loop Guard Tool-Call Reminder",
		description:
			"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)",
	},
});

export const cfgModelToolCallLoopGuardEnabled = register({
	id: "toolCallLoopGuard.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Tool-Call Loop Guard",
		description: "Detect consecutive identical tool calls across turns and inject a corrective steer",
	},
});

export const cfgModelToolCallLoopGuardThreshold = register({
	id: "toolCallLoopGuard.threshold",
	type: "number",
	default: 5,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Tool-Call Loop Threshold",
		description: "Consecutive identical tool calls required before the corrective steer is injected",
	},
});

export const cfgModelToolCallLoopGuardExemptTools = register({
	id: "toolCallLoopGuard.exemptTools",
	type: "array",
	default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Tool-Call Loop Exempt Tools",
		description: "Tool names that may repeat consecutively without triggering the cross-turn loop guard",
	},
});

export const cfgInlineToolDescriptors = register({
	id: "inlineToolDescriptors",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Inline Tool Descriptors",
		description:
			"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Inline descriptors for Gemini models; keep them in tool schemas otherwise",
			},
			{ value: "on", label: "On", description: "Always inline descriptors in the system prompt" },
			{ value: "off", label: "Off", description: "Keep descriptors in provider tool schemas only" },
		],
	},
});

export const cfgIncludeModelInPrompt = register({
	id: "includeModelInPrompt",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Include Model in Prompt",
		description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
	},
});

export const cfgIncludeWorkspaceTree = register({
	id: "includeWorkspaceTree",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Include Workspace Tree",
		description:
			"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.",
	},
});

export const cfgSkillful = register({
	id: "skillful",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "List Skills in Prompt",
		description:
			"List available skills in the system prompt; disable to save context and toggle per-session with /skillful",
	},
});

/** Personality preset. */
export type Personality = SettingValueOf<typeof cfgPersonality>;

export const cfgPersonality = register({
	id: "personality",
	type: "enum",
	values: ["default", "friendly", "pragmatic", "none"] as const,
	default: "default",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Personality",
		description: "Communication style rendered into the system prompt's personality block",
		options: [
			{
				value: "default",
				label: "Default",
				description: "Terse, evidence-first engineer; dense, action-oriented replies",
			},
			{
				value: "friendly",
				label: "Friendly",
				description: "Warm, encouraging collaborator focused on momentum and morale",
			},
			{
				value: "pragmatic",
				label: "Pragmatic",
				description: "Direct, efficient engineer focused on clarity and rigor",
			},
			{ value: "none", label: "None", description: "Omit the personality block entirely" },
		],
	},
});

// Sampling
export const cfgTemperature = register({
	id: "temperature",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Temperature",
		description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "0", label: "0", description: "Deterministic" },
			{ value: "0.2", label: "0.2", description: "Focused" },
			{ value: "0.5", label: "0.5", description: "Balanced" },
			{ value: "0.7", label: "0.7", description: "Creative" },
			{ value: "1", label: "1", description: "Maximum variety" },
		],
	},
});

export const cfgTopP = register({
	id: "topP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Top P",
		description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "0.1", label: "0.1", description: "Very focused" },
			{ value: "0.3", label: "0.3", description: "Focused" },
			{ value: "0.5", label: "0.5", description: "Balanced" },
			{ value: "0.9", label: "0.9", description: "Broad" },
			{ value: "1", label: "1", description: "No nucleus filtering" },
		],
	},
});

export const cfgTopK = register({
	id: "topK",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Top K",
		description: "Sample from top-K tokens (-1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "1", label: "1", description: "Greedy top token" },
			{ value: "20", label: "20", description: "Focused" },
			{ value: "40", label: "40", description: "Balanced" },
			{ value: "100", label: "100", description: "Broad" },
		],
	},
});

export const cfgMinP = register({
	id: "minP",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Min P",
		description: "Minimum probability threshold (0-1, -1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "0.01", label: "0.01", description: "Very permissive" },
			{ value: "0.05", label: "0.05", description: "Balanced" },
			{ value: "0.1", label: "0.1", description: "Strict" },
		],
	},
});

export const cfgPresencePenalty = register({
	id: "presencePenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Presence Penalty",
		description: "Penalty for introducing already-present tokens (-1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "0", label: "0", description: "No penalty" },
			{ value: "0.5", label: "0.5", description: "Mild novelty" },
			{ value: "1", label: "1", description: "Encourage novelty" },
			{ value: "2", label: "2", description: "Strong novelty" },
		],
	},
});

export const cfgRepetitionPenalty = register({
	id: "repetitionPenalty",
	type: "number",
	default: -1,
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Repetition Penalty",
		description: "Penalty for repeated tokens (-1 = provider default)",
		options: [
			{ value: "-1", label: "Default", description: "Use provider default" },
			{ value: "0.8", label: "0.8", description: "Allow repetition" },
			{ value: "1", label: "1", description: "No penalty" },
			{ value: "1.1", label: "1.1", description: "Mild penalty" },
			{ value: "1.2", label: "1.2", description: "Balanced" },
			{ value: "1.5", label: "1.5", description: "Strong penalty" },
		],
	},
});

const providerDefaultWhenNegative = (value: number): number | undefined => (value >= 0 ? value : undefined);

/** Agent sampling options; a negative sampling setting means "provider default" (`undefined`). */
export const cfgSampling = combine(
	{
		temperature: cfgTemperature,
		topP: cfgTopP,
		topK: cfgTopK,
		minP: cfgMinP,
		presencePenalty: cfgPresencePenalty,
		repetitionPenalty: cfgRepetitionPenalty,
		hideThinkingSummary: cfgOmitThinking,
	},
	values => ({
		temperature: providerDefaultWhenNegative(values.temperature),
		topP: providerDefaultWhenNegative(values.topP),
		topK: providerDefaultWhenNegative(values.topK),
		minP: providerDefaultWhenNegative(values.minP),
		presencePenalty: providerDefaultWhenNegative(values.presencePenalty),
		repetitionPenalty: providerDefaultWhenNegative(values.repetitionPenalty),
		hideThinkingSummary: values.hideThinkingSummary,
	}),
);

export const cfgTextVerbosity = register({
	id: "textVerbosity",
	type: "enum",
	values: ["low", "medium", "high"] as const,
	default: "low",
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Text Verbosity",
		description: "OpenAI Responses and Codex response verbosity (low, medium, or high)",
		options: [
			{ value: "low", label: "Low", description: "Prefer concise responses (default)" },
			{ value: "medium", label: "Medium", description: "Balance brevity and detail" },
			{ value: "high", label: "High", description: "Prefer detailed responses" },
		],
	},
});

export const cfgTierOpenai = register({
	id: "tier.openai",
	type: "enum",
	values: SERVICE_TIER_OPENAI_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Service Tier — OpenAI",
		description:
			"Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.",
		options: SERVICE_TIER_OPENAI_OPTIONS,
	},
});

export const cfgTierSubagent = register({
	id: "tier.subagent",
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "inherit",
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Service Tier — Subagent",
		description:
			"Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.",
		options: SERVICE_TIER_INHERIT_OPTIONS,
	},
});

export const cfgTierAdvisor = register({
	id: "tier.advisor",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: SERVICE_TIER_INHERIT_SETTING_VALUES,
	default: "none",
	ui: {
		tab: "model",
		group: "Sampling",
		label: "Service Tier — Advisor",
		description:
			"Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.",
		options: SERVICE_TIER_INHERIT_OPTIONS,
		condition: "advisorEnabled",
	},
});

// Retries
export const cfgRetryEnabled = register({ id: "retry.enabled", type: "boolean", default: true });

export const cfgRetryMaxRetries = register({
	id: "retry.maxRetries",
	type: "number",
	default: 10,
	ui: {
		tab: "model",
		group: "Retry",
		label: "Retry Attempts",
		description: "Maximum retry attempts on API errors",
		options: [
			{ value: "1", label: "1 retry" },
			{ value: "2", label: "2 retries" },
			{ value: "3", label: "3 retries" },
			{ value: "5", label: "5 retries" },
			{ value: "10", label: "10 retries" },
		],
	},
});

export const cfgRetryBaseDelayMs = register({ id: "retry.baseDelayMs", type: "number", default: 500 });

export const cfgRetryMaxDelayMs = register({
	id: "retry.maxDelayMs",
	type: "number",
	default: 5 * 60 * 1000,
	ui: {
		tab: "model",
		group: "Retry",
		label: "Max Retry Delay",
		description:
			"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no other credential can serve the same model, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets.",
	},
});

/** Retry/backoff and same-model account reserve policy. */
export const cfgRetry = combine({
	enabled: cfgRetryEnabled,
	maxRetries: cfgRetryMaxRetries,
	baseDelayMs: cfgRetryBaseDelayMs,
	maxDelayMs: cfgRetryMaxDelayMs,
});

/** Retry/backoff policy ({@link cfgRetry}). */
export type RetrySettings = SettingValueOf<typeof cfgRetry>;

export const cfgProvidersWebSearchTimeoutSeconds = register({
	id: "providers.webSearchTimeoutSeconds",
	type: "number",
	default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Web Search Timeout",
		description: `Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum ${MAX_WEB_SEARCH_TIMEOUT_SECONDS})`,
		options: [
			{ value: "30", label: "30 seconds" },
			{ value: "60", label: "1 minute" },
			{ value: "120", label: "2 minutes" },
			{ value: "180", label: "3 minutes" },
			{ value: "300", label: "5 minutes" },
		],
	},
});

export const cfgFeaturesUnexpectedStopDetection = register({
	id: "features.unexpectedStopDetection",
	type: "enum",
	values: ["none", "mechanical"] as const,
	default: "mechanical",
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Unexpected Stops",
		description: "Automatically retry the current model when the assistant stops without a visible message.",
		options: [
			{ value: "none", label: "None", description: "Disabled" },
			{
				value: "mechanical",
				label: "Mechanical",
				description: "Retry stops with no visible assistant message; tool calls are excluded (default)",
			},
		],
	},
});

// Process-wide too, so side requests that call `completeSimple`/`streamSimple`
// directly (titles, commit messages) follow the setting.

// Sessions pass their own value per request; this process-wide default covers
// callers without a session stream function (titles, commit messages).

export const cfgProvidersStreamFirstEventTimeoutSeconds = register({
	id: "providers.streamFirstEventTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: "Stream First Event Timeout",
		description:
			"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
		options: [
			{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
			{ value: "0", label: "Off", description: "Disable first-event timeout" },
			{ value: "300", label: "5 minutes" },
			{ value: "600", label: "10 minutes" },
			{ value: "1800", label: "30 minutes" },
		],
	},
});

export const cfgProvidersStreamIdleTimeoutSeconds = register({
	id: "providers.streamIdleTimeoutSeconds",
	type: "number",
	default: -1,
	ui: {
		tab: "providers",
		group: "Timeouts",
		label: "Stream Idle Timeout",
		description:
			"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
		options: [
			{ value: "-1", label: "Auto", description: "Use provider defaults and PI_* timeout env vars" },
			{ value: "0", label: "Off", description: "Disable idle timeout" },
			{ value: "300", label: "5 minutes" },
			{ value: "600", label: "10 minutes" },
			{ value: "1800", label: "30 minutes" },
		],
	},
});

export const cfgProvidersFetch = register({
	id: "providers.fetch",
	type: "enum",
	values: ["auto", "native", "trafilatura", "lynx", "parallel", "firecrawl", "jina"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Fetch Provider",
		description: "Reader backend priority for the fetch/read URL tool",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "Priority: native > trafilatura > lynx > parallel > firecrawl > jina",
			},
			{ value: "native", label: "Native", description: "In-process HTML→Markdown converter (always available)" },
			{ value: "trafilatura", label: "Trafilatura", description: "Auto-installs via uv/pip" },
			{ value: "lynx", label: "Lynx", description: "Requires lynx system package" },
			{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
			{ value: "firecrawl", label: "Firecrawl", description: "Requires FIRECRAWL_API_KEY" },
			{ value: "jina", label: "Jina", description: "Uses r.jina.ai reader (JINA_API_KEY optional)" },
		],
	},
});



export const cfgProviderAppendOnlyContext = register({
	id: "provider.appendOnlyContext",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "providers",
		group: "Protocol",
		label: "Append-Only Context",
		description:
			"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
		options: [
			{ value: "auto", label: "Auto", description: "Enable for known prefix-cache providers (recommended)" },
			{ value: "on", label: "On", description: "Always enable append-only context" },
			{ value: "off", label: "Off", description: "Disable append-only context" },
		],
	},
});

export const cfgThinkingBudgetsMinimal = register({ id: "thinkingBudgets.minimal", type: "number", default: 1024 });

export const cfgThinkingBudgetsLow = register({ id: "thinkingBudgets.low", type: "number", default: 2048 });

export const cfgThinkingBudgetsMedium = register({ id: "thinkingBudgets.medium", type: "number", default: 8192 });

export const cfgThinkingBudgetsHigh = register({ id: "thinkingBudgets.high", type: "number", default: 16384 });

export const cfgThinkingBudgetsXhigh = register({ id: "thinkingBudgets.xhigh", type: "number", default: 32768 });

export const cfgThinkingBudgetsMax = register({ id: "thinkingBudgets.max", type: "number", default: 32768 });

/** Token budget per thinking level (`thinkingBudgets.*`) on transports that accept reasoning token budgets. */
export const cfgThinkingBudgets = combine({
	minimal: cfgThinkingBudgetsMinimal,
	low: cfgThinkingBudgetsLow,
	medium: cfgThinkingBudgetsMedium,
	high: cfgThinkingBudgetsHigh,
	xhigh: cfgThinkingBudgetsXhigh,
	max: cfgThinkingBudgetsMax,
});

/** Rejects a cost threshold that is not a positive USD amount. */
function validateCostThreshold(id: string): (raw: unknown) => void {
	return raw => {
		if (raw === undefined || raw === null || (typeof raw === "number" && Number.isFinite(raw) && raw > 0)) return;
		throw new Error(`Invalid ${id}: expected a positive USD amount, got ${Bun.inspect(raw)}.`);
	};
}

/** Session-tree spend (USD) at which omp warns once; `--warn-cost` overrides it for one run. */
export const cfgSessionWarnCost = register({
	id: "session.warnCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.warnCost"),
});

/** Session-tree spend (USD) at which omp stops sending model requests; `--max-cost` overrides it for one run. */
export const cfgSessionMaxCost = register({
	id: "session.maxCost",
	type: "number",
	default: undefined,
	validate: validateCostThreshold("session.maxCost"),
});
