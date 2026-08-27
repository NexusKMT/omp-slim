/**
 * AI-assisted selective staging for the git TUI ("what should we stage?").
 *
 * Runs two fanned-out tiny-model passes over the unstaged tree: a permissive
 * per-file pass rejects files that cannot match the user's instruction, then a
 * per-hunk pass over the surviving files picks the exact hunks. Matching hunks
 * are staged via `git apply --cached`; accepted untracked and binary files are
 * staged whole. Every judgement is an independent yes/no completion, so both
 * passes run fully in parallel (the provider in-flight limiter bounds the
 * blast).
 */
import * as path from "node:path";
import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	completeSimple,
	type Model,
	retryTransientCompletion,
} from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { parseFileHunks } from "../../commit/git/diff";
import type { FileDiff } from "../../commit/types";
import { ModelRegistry } from "../../config/model-registry";
import { resolveRoleSelection } from "../../config/model-resolver";
import { Settings } from "../../config/settings";
import filePromptTemplate from "../../prompts/system/git-ai-stage-file.md" with { type: "text" };
import hunkPromptTemplate from "../../prompts/system/git-ai-stage-hunk.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../../sdk";
import * as git from "../../utils/git";
import type { ChangedFile } from "./state";

/** Head-truncation bound for per-file diff excerpts in the file pass. */
const FILE_EXCERPT_CHARS = 1600;
/** Head-truncation bound for hunk text in the hunk pass. */
const HUNK_CHARS = 2400;
/**
 * Mirrors the auto-thinking classifier budget: leaves room for thinking
 * preambles on backends that ignore `disableReasoning`, and stays above
 * Anthropic-dialect `thinking.budget_tokens` minimums (issues #4355, #8610).
 */
const SAFE_MAX_TOKENS = 4096;

/** Counts reported back to the status line after an AI staging run. */
export interface AiStageOutcome {
	/** Files accepted by the file pass. */
	matchedFiles: number;
	/** Files evaluated in the file pass. */
	totalFiles: number;
	/** Hunks staged by the hunk pass. */
	stagedHunks: number;
	/** Hunks evaluated in matched files. */
	totalHunks: number;
	/** Untracked/binary files staged whole. */
	wholeFiles: number;
}

/** Options for {@link aiStage}. */
export interface AiStageOptions {
	cwd: string;
	/** The user's natural-language description of what to stage. */
	instruction: string;
	/** Unstaged sidebar entries; conflicted files are skipped. */
	files: readonly Pick<ChangedFile, "path" | "kind">[];
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/**
 * Filter the unstaged tree against `instruction` with the tiny/smol model and
 * stage the matching hunks. Called by the git TUI's unstaged-header wand pill.
 * @throws when no model/key resolves, git fails, or every judgement in a pass errors.
 */
export async function aiStage(options: AiStageOptions): Promise<AiStageOutcome> {
	const { cwd, instruction, signal, onProgress } = options;
	const untracked = options.files.filter(file => file.kind === "untracked");
	const tracked = options.files.filter(file => file.kind !== "untracked" && file.kind !== "conflicted");
	if (tracked.length === 0 && untracked.length === 0) throw new Error("No unstaged changes to filter");

	onProgress?.("Resolving model…");
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		const model = resolveRoleSelection(["tiny", "smol"], settings, registry.getAvailable())?.model;
		if (!model) throw new Error("No tiny/smol model available for AI staging");
		if (!(await registry.getApiKey(model))) throw new Error(`No API key for ${model.provider}/${model.id}`);
		const judge = createJudge(model, registry.resolver(model), signal);

		const rawDiff = tracked.length > 0 ? await git.diff(cwd, { files: tracked.map(file => file.path), signal }) : "";
		const fileDiffs = new Map(git.diff.parseFiles(rawDiff).map(entry => [entry.filename, entry]));

		interface Candidate {
			file: Pick<ChangedFile, "path" | "kind">;
			/** Parsed worktree diff; absent for untracked files. */
			diff?: FileDiff;
			excerpt: string;
		}
		const candidates: Candidate[] = tracked.flatMap(file => {
			const diff = fileDiffs.get(file.path);
			return diff ? [{ file, diff, excerpt: bound(diff.content, FILE_EXCERPT_CHARS) }] : [];
		});
		candidates.push(
			...(await Promise.all(
				untracked.map(async file => ({ file, excerpt: await untrackedExcerpt(cwd, file.path) })),
			)),
		);

		// File pass: reject files that cannot match; everything else advances.
		let filesJudged = 0;
		const fileVerdicts = await judgeAll(candidates, async candidate => {
			const accepted = await judge(
				prompt.render(filePromptTemplate, {
					instruction,
					path: candidate.file.path,
					kind: candidate.file.kind,
					excerpt: candidate.excerpt,
					// No hunk pass follows for untracked/binary files: this verdict stages the whole file.
					final: !candidate.diff || candidate.diff.isBinary,
				}),
			);
			onProgress?.(`Choosing files… ${++filesJudged}/${candidates.length}`);
			return accepted;
		});
		const matched = candidates.filter((_, index) => fileVerdicts[index]);

		// Hunk pass: every hunk of every matched text file is judged independently.
		const binaryWhole: string[] = [];
		const jobs: { path: string; index: number; changed: string }[] = [];
		for (const candidate of matched) {
			if (!candidate.diff) continue;
			if (candidate.diff.isBinary) {
				binaryWhole.push(candidate.file.path);
				continue;
			}
			for (const hunk of parseFileHunks(candidate.diff).hunks) {
				// Small judges misread unchanged context as part of the change, so
				// only the +/− lines go to the model.
				const changed = hunk.content
					.split("\n")
					.filter(line => line.startsWith("+") || line.startsWith("-"))
					.join("\n");
				if (changed.length === 0) continue;
				// HunkSelection indices are 1-based; parsed hunk.index is 0-based.
				jobs.push({ path: candidate.file.path, index: hunk.index + 1, changed });
			}
		}
		let hunksJudged = 0;
		const hunkVerdicts = await judgeAll(jobs, async job => {
			const accepted = await judge(
				prompt.render(hunkPromptTemplate, {
					instruction,
					path: job.path,
					changed: bound(job.changed, HUNK_CHARS),
				}),
			);
			onProgress?.(`Choosing hunks… ${++hunksJudged}/${jobs.length}`);
			return accepted;
		});

		const indicesByPath = new Map<string, number[]>();
		jobs.forEach((job, index) => {
			if (!hunkVerdicts[index]) return;
			const indices = indicesByPath.get(job.path);
			if (indices) indices.push(job.index);
			else indicesByPath.set(job.path, [job.index]);
		});

		const selections: git.HunkSelection[] = [
			...binaryWhole.map(filePath => ({ path: filePath, hunks: { type: "all" } as const })),
			...[...indicesByPath].map(([filePath, indices]) => ({
				path: filePath,
				hunks: { type: "indices", indices } as const,
			})),
		];
		const untrackedAccepted = matched.filter(candidate => !candidate.diff).map(candidate => candidate.file.path);
		const stagedHunks = hunkVerdicts.filter(Boolean).length;
		if (selections.length > 0 || untrackedAccepted.length > 0) onProgress?.("Staging…");
		if (selections.length > 0) await git.stage.hunks(cwd, selections, { rawDiff, signal });
		if (untrackedAccepted.length > 0) await git.stage.files(cwd, untrackedAccepted, signal);

		return {
			matchedFiles: matched.length,
			totalFiles: candidates.length,
			stagedHunks,
			totalHunks: jobs.length,
			wholeFiles: untrackedAccepted.length + binaryWhole.length,
		};
	} finally {
		authStorage.close();
	}
}

/** One yes/no completion against the resolved model. */
function createJudge(
	model: Model<Api>,
	apiKey: ApiKey,
	signal?: AbortSignal,
): (userPrompt: string) => Promise<boolean> {
	return async userPrompt => {
		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{ messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
					{ apiKey, maxTokens: SAFE_MAX_TOKENS, temperature: 0, disableReasoning: true, signal },
				),
			{ signal },
		);
		if (response.stopReason === "error") {
			throw new Error(`AI staging request failed: ${response.errorMessage ?? "unknown error"}`);
		}
		return parseVerdict(extractText(response.content));
	};
}

/**
 * Fan out one judgement per item. A failed judgement rejects just its item so
 * one flaky request cannot sink the run — unless every item failed, which
 * means the backend is broken and the first error surfaces.
 */
async function judgeAll<T>(items: readonly T[], run: (item: T) => Promise<boolean>): Promise<boolean[]> {
	let failures = 0;
	let firstError: unknown;
	const verdicts = await Promise.all(
		items.map(async item => {
			try {
				return await run(item);
			} catch (error) {
				failures++;
				firstError ??= error;
				logger.debug("git ai-stage: judgement failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		}),
	);
	if (items.length > 0 && failures === items.length) {
		throw firstError instanceof Error ? firstError : new Error(String(firstError));
	}
	return verdicts;
}

/** Earliest bare `yes` before any `no` accepts; anything else rejects. */
export function parseVerdict(text: string): boolean {
	const lower = text.toLowerCase();
	const yes = lower.search(/\byes\b/);
	if (yes < 0) return false;
	const no = lower.search(/\bno\b/);
	return no < 0 || yes < no;
}

function bound(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}

/** Bounded head of an untracked worktree file; empty for unreadable or binary content. */
async function untrackedExcerpt(cwd: string, filePath: string): Promise<string> {
	try {
		const text = await Bun.file(path.join(cwd, filePath)).slice(0, FILE_EXCERPT_CHARS).text();
		return text.includes("\u0000") ? "" : text;
	} catch {
		return "";
	}
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}
