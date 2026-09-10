import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { expandTilde } from "../tools/path-utils";

const PLAN_SAVE_STEM_MAX_LENGTH = 32;
const MAX_AUTOSAVE_CANDIDATES = 1000;

type PlanAutosaveSettings = Pick<Settings, "get">;

/** Suggested save filename for an approved plan: `<TOPIC>_PLAN.md` from the
 *  tiny-model topic (e.g. `PYO3_METHODS_PLAN.md`), trimmed to a word boundary
 *  when a verbose fallback title sneaks through. */
export function planSaveFileName(title: string): string {
	let stem = title
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (stem.length > PLAN_SAVE_STEM_MAX_LENGTH) {
		const cut = stem.lastIndexOf("_", PLAN_SAVE_STEM_MAX_LENGTH);
		stem = cut > 0 ? stem.slice(0, cut) : stem.slice(0, PLAN_SAVE_STEM_MAX_LENGTH);
	}
	if (!stem || stem === "PLAN") return "PLAN.md";
	return `${stem.endsWith("_PLAN") ? stem : `${stem}_PLAN`}.md`;
}

/** Default autosave location: `<project>/.omp/plans/`. */
export function defaultPlanAutosaveDir(cwd: string): string {
	return path.join(getProjectAgentDir(cwd), "plans");
}

/** Resolve the autosave directory: `plan.autosaveDir` (`~`/absolute/cwd-relative)
 *  or the project-local default when unset/blank. */
export function resolvePlanAutosaveDir(settings: PlanAutosaveSettings, cwd: string): string {
	const raw = settings.get("plan.autosaveDir");
	if (typeof raw !== "string" || raw.trim() === "") return defaultPlanAutosaveDir(cwd);
	const expanded = expandTilde(raw.trim());
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.resolve(cwd, expanded);
}

export function isPlanAutosaveEnabled(settings: PlanAutosaveSettings): boolean {
	try {
		return settings.get("plan.autosave") === true;
	} catch {
		return false;
	}
}

function autosaveCandidate(dir: string, filename: string, index: number): string {
	if (index === 0) return path.join(dir, filename);
	const ext = path.extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	return path.join(dir, `${stem}-${index}${ext}`);
}

async function autosavePathExists(candidate: string): Promise<boolean> {
	try {
		await fs.stat(candidate);
		return true;
	} catch {
		return false;
	}
}

/** First non-colliding `<dir>/<filename>` (`<stem>-<n><ext>` on collision). */
export async function resolveUniqueAutosavePath(dir: string, filename: string): Promise<string> {
	for (let index = 0; index < MAX_AUTOSAVE_CANDIDATES; index += 1) {
		const candidate = autosaveCandidate(dir, filename, index);
		if (!(await autosavePathExists(candidate))) return candidate;
	}
	return path.join(dir, `${Date.now()}-${filename}`);
}

/** Best-effort copy of an approved plan into the autosave dir.
 *  Returns the destination path, or null when autosave is disabled/empty. */
export async function autosaveApprovedPlan(input: {
	settings: PlanAutosaveSettings;
	cwd: string;
	title: string;
	planContent: string;
}): Promise<string | null> {
	if (!isPlanAutosaveEnabled(input.settings)) return null;
	if (input.planContent.trim() === "") return null;
	const dir = resolvePlanAutosaveDir(input.settings, input.cwd);
	const destination = await resolveUniqueAutosavePath(dir, planSaveFileName(input.title));
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await Bun.write(destination, input.planContent);
	return destination;
}
