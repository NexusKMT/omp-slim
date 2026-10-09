/**
 * `omp anonymize` — write a shareable copy of a session (and its subagent
 * transcripts) with turn contents redacted and metadata preserved.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { ANONYMIZED_REVIEW_NOTE, anonymizeSessionTranscripts } from "../session/session-anonymizer";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { loadSessionFile } from "../session/session-loader";
import { resolveSessionFileArg } from "./session-arg";
import { CliUsageError } from "./usage-error";

export interface AnonymizeCommandArgs {
	/** Session file path or id prefix (default: most recent for cwd). */
	session?: string;
	/** Output directory (default: `./<session-file-stem>.anon`). */
	out?: string;
}

export async function runAnonymizeCommand(args: AnonymizeCommandArgs): Promise<void> {
	const sourcePath = await resolveSessionFileArg(args.session, getProjectDir());
	const outDir = path.resolve(args.out ?? `${path.basename(sourcePath, ".jsonl")}.anon`);
	const { entries: records, malformedRecords } = await loadSessionFile(sourcePath);
	// The loader returns [] for a file without a valid session header.
	const header = records.find((record): record is SessionHeader => record.type === "session");
	if (!header) throw new CliUsageError(`${sourcePath} is not a valid session file`);
	const result = await anonymizeSessionTranscripts({
		header,
		entries: records.filter((record): record is SessionEntry => record.type !== "session"),
		sessionFile: sourcePath,
	});
	const targets = result.files.map(([name, content]) => [path.join(outDir, name), content] as const);
	// Never overwrite the input: `-o <session dir>` would replace the session (or a subagent
	// transcript under `<stem>/`) with its redacted copy. Only existing targets can collide.
	const sourceReal = await fs.realpath(sourcePath);
	const subagentDirReal = `${sourceReal.slice(0, -".jsonl".length)}${path.sep}`;
	for (const [target] of targets) {
		let targetReal: string;
		try {
			targetReal = await fs.realpath(target);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		if (targetReal === sourceReal || targetReal.startsWith(subagentDirReal)) {
			throw new CliUsageError(
				`Refusing to overwrite source transcript ${targetReal}; choose another --out directory`,
			);
		}
	}
	for (const [target, content] of targets) await Bun.write(target, content);

	const count = result.files.length;
	process.stdout.write(`Anonymized ${count} transcript${count === 1 ? "" : "s"} → ${outDir}\n`);
	if (result.subagentError) process.stdout.write(`Subagent transcripts unavailable: ${result.subagentError}\n`);
	if (malformedRecords > 0) {
		process.stdout.write(
			`Skipped ${malformedRecords} malformed record${malformedRecords === 1 ? "" : "s"} in ${sourcePath}; the export omits them\n`,
		);
	}
	process.stdout.write(`${ANONYMIZED_REVIEW_NOTE}\n`);
}
