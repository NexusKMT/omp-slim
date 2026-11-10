import type { TextContent } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { discoverAgents } from "../task/discovery";
import { isBundledSeance, resolveSeanceSource } from "../task/seance";
import { SEANCE_AGENT_NAME } from "../task/seance-policy";
import seanceCommandPrompt from "../prompts/system/seance-command.md" with { type: "text" };
import seanceCommandSolutionSpace from "../prompts/system/seance-command-solution-space.md" with { type: "text" };
import { parseCommandArgs } from "../utils/command-args";
import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";
import type { InteractiveModeContext } from "../modes/types";

type ParsedSeanceArgs = { source: string | undefined } | { error: string };

function parseSeanceArgs(args: string): ParsedSeanceArgs {
	const tokens = parseCommandArgs(args, { strict: false });
	let source: string | undefined;
	for (const token of tokens) {
		if (token.startsWith("-")) return { error: `Unknown /seance option: ${token}` };
		if (source !== undefined) return { error: "Usage: /seance [session id|path]" };
		source = token;
	}
	return { source };
}

async function launchSeance(ctx: InteractiveModeContext, sourceSession: string): Promise<void> {
	const taskTool = ctx.session.agent.state.tools.find(tool => tool.name === "task");
	if (!taskTool) {
		ctx.showError("The task tool is not available for /seance.");
		return;
	}
	const params: TaskParams = {
		agent: SEANCE_AGENT_NAME,
		sourceSession,
		task: seanceCommandPrompt,
		solutionSpace: seanceCommandSolutionSpace.trim(),
	};
	const taskIds = new Set<string>();
	let jobId: string | undefined;
	let selectedModel: string | undefined;
	const collect = (details: TaskToolDetails | undefined): void => {
		if (!details) return;
		for (const progress of details.progress ?? []) {
			taskIds.add(progress.id);
			if (progress.resolvedModel) selectedModel = progress.resolvedModel;
		}
		for (const item of details.results ?? []) {
			taskIds.add(item.id);
			if (item.resolvedModel) selectedModel = item.resolvedModel;
		}
		jobId = details.async?.jobId ?? jobId;
	};
	try {
		const result = await taskTool.execute(`seance-${Snowflake.next()}`, params, undefined, update => {
			collect(update.details as TaskToolDetails | undefined);
		});
		const details = result.details as TaskToolDetails | undefined;
		collect(details);
		const content = result.content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim();
		const failedResult = details?.results?.find(item => item.error || item.aborted || item.exitCode !== 0);
		if (
			result.isError ||
			details?.async?.state === "failed" ||
			failedResult ||
			(!details?.async && (details?.results?.length ?? 0) === 0)
		) {
			const failureMessage = failedResult?.aborted
				? failedResult.abortReason || content || failedResult.error || "Seance preflight failed."
				: content || failedResult?.error || "Seance preflight failed.";
			ctx.showError(sanitizeErrorLine(failureMessage));
			return;
		}
		const state = details?.async?.state === "running" ? "running" : "completed";
		const taskLabel = taskIds.size > 0 ? [...taskIds].join(", ") : jobId;
		const modelLabel = selectedModel ? ` · ${selectedModel}` : "";
		ctx.showStatus(sanitizeErrorLine(`Seance ${state}${taskLabel ? `: ${taskLabel}` : ""}${modelLabel}`));
	} catch (error) {
		ctx.showError(sanitizeErrorLine(error));
	}
}

async function consultSeance(ctx: InteractiveModeContext, selector: string, sessionDirHint?: string): Promise<void> {
	try {
		const { agents } = await discoverAgents(
			ctx.sessionManager.getCwd(),
			undefined,
			ctx.session.effectiveExtensionRoots,
		);
		const seanceAgent = agents.find(agent => agent.name === SEANCE_AGENT_NAME);
		if (!seanceAgent || !isBundledSeance(seanceAgent)) {
			throw new Error("A custom `seance` agent overrides the bundled one; rename it to use /seance.");
		}
		const source = await resolveSeanceSource(selector, {
			cwd: ctx.sessionManager.getCwd(),
			sessionDirHint,
			includeGlobal: true,
		});
		void launchSeance(ctx, source.file);
	} catch (error) {
		ctx.showError(sanitizeErrorLine(error));
	}
}

export const SEANCE_SLASH_COMMAND: SlashCommandSpec = {
	name: "seance",
	icon: "ghost",
	description: "Consult a saved session without resuming it",
	inlineHint: "[session id|path]",
	allowArgs: true,
	handleTui: async (command, runtime) => {
		clearSubmittedText(runtime);
		const parsed = parseSeanceArgs(command.args);
		if ("error" in parsed) {
			runtime.ctx.showError(sanitizeErrorLine(parsed.error));
			return;
		}
		if (!parsed.source) {
			runtime.ctx.showSessionSelector(undefined, session => consultSeance(runtime.ctx, session.path));
			return;
		}
		await consultSeance(runtime.ctx, parsed.source, runtime.ctx.sessionManager.getSessionDir());
	},
};
