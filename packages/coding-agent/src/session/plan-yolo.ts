import type { Agent, AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../plan-mode/plan-autosave";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import { isMCPToolName } from "../tools/builtin-names";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import type { PlanProposalHandler } from "../tools/resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import type { SessionManager } from "./session-manager";
/** Retired prewalk guidance must never be replayed from old session history. */
export function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}

export interface PlanYoloCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setActiveToolsByName(names: string[]): Promise<void>;
	restoreNonMCPToolPresentation(
		nonMCPToolNames: string[],
		nonMCPMountedToolNames: string[],
		registeredToolNames: readonly string[],
	): Promise<void>;
	getAllToolNames(): string[];
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	getMountedXdevToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	localProtocolOptions(): LocalProtocolOptions;
}

const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";
export class PlanYoloCoordinator {
	readonly #host: PlanYoloCoordinatorHost;
	#planYolo: boolean;
	#planYoloPreviousNonMCPPresentation: { enabled: string[]; mounted: string[]; registered: string[] } | undefined;
	#planYoloArmed = false;
	constructor(host: PlanYoloCoordinatorHost, enabled = false) {
		this.#host = host;
		this.#planYolo = enabled;
	}
	/** Lazily enables plan-yolo's plan phase before the first prompt is built. */
	async armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousEnabledTools = this.#host.getEnabledToolNames();
		const previousMountedTools = this.#host.getMountedXdevToolNames();
		const previousRegisteredTools = this.#host.getAllToolNames();
		const previousPlanModeState = this.#host.getPlanModeState();
		const planModeState: PlanModeState = {
			enabled: true,
			planFilePath: this.#host.getPlanReferencePath() || "local://PLAN.md",
			workflow: "parallel",
		};
		// PlanYolo's injected write is a plan transport, not a user grant. Publish
		// plan mode before applying the tool set so SessionTools keeps an existing
		// device-only write restricted.
		this.#host.setPlanModeState(planModeState);
		// Only the built-in write carries the xd:// propose transport. A shadowing
		// extension `write` would answer every proposal as a file write and the plan
		// phase would never end (#14030), so it is left out of the plan tool set.
		const planTools = this.#host.hasBuiltInTool("write")
			? [...previousEnabledTools, "write"]
			: previousEnabledTools.filter(name => name !== "write");
		try {
			await this.#host.setActiveToolsByName([...new Set(planTools)]);
		} catch (error) {
			this.#host.setPlanModeState(previousPlanModeState);
			this.#planYoloArmed = false;
			throw error;
		}
		this.#planYoloPreviousNonMCPPresentation = {
			enabled: previousEnabledTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
			registered: previousRegisteredTools,
		};
		this.#host.setPlanProposalHandler(title => this.#finalizePlanYoloProposal(title));
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const state = this.#host.getPlanModeState();
		if (!this.#planYolo || !state?.enabled) throw new ToolError("Plan mode is not active.");
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url =>
				readPlanFile(url, {
					localProtocolOptions: this.#host.localProtocolOptions(),
					cwd: this.#host.sessionManager.getCwd(),
				}),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#host.localProtocolOptions() }),
		});
		let autosavedPlan: string | null = null;
		try {
			autosavedPlan = await autosaveApprovedPlan({
				settings: this.#host.settings,
				cwd: this.#host.sessionManager.getCwd(),
				title: resolvedTitle,
				planContent,
			});
			if (autosavedPlan) {
				const displayPath = truncateToWidth(replaceTabs(shortenPath(autosavedPlan)), TRUNCATE_LENGTHS.CONTENT);
				this.#host.emitNotice("info", `Plan autosaved to ${displayPath}.`, "plan-yolo");
			}
		} catch (error) {
			logger.warn("Failed to autosave approved plan", { error });
			const detail = truncateToWidth(
				shortenEmbeddedPaths(
					replaceTabs(error instanceof Error ? error.message : String(error))
						.replace(/[\r\n]+/g, " ")
						.trim(),
				),
				TRUNCATE_LENGTHS.CONTENT,
			);
			this.#host.emitNotice(
				"warning",
				`Plan autosave failed: ${detail} Continuing with implementation.`,
				"plan-yolo",
			);
		}
		this.#host.setPlanModeState(undefined);
		const previousPresentation = this.#planYoloPreviousNonMCPPresentation;
		try {
			if (previousPresentation) {
				await this.#host.restoreNonMCPToolPresentation(
					previousPresentation.enabled,
					previousPresentation.mounted,
					previousPresentation.registered,
				);
			}
		} catch (error) {
			this.#host.setPlanModeState(state);
			throw error;
		}
		this.#host.setPlanProposalHandler(null);
		this.#planYolo = false;
		this.#planYoloPreviousNonMCPPresentation = undefined;
		this.#host.emitNotice(
			"info",
			`Plan-yolo: plan approved, implementing "${resolvedTitle}" with the current model.`,
			"plan-yolo",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
			content: prompt.render(planYoloHandoffPrompt, { planFilePath, title: resolvedTitle }),
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
		return {
			content: [{ type: "text", text: "Plan approved. Implementing now with the current model." }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}
}
