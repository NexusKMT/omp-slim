/**
 * `omp anonymize` — write a shareable copy of a session (and its subagent
 * transcripts) with turn contents redacted and metadata preserved.
 */
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { anonymizeSessionTranscripts } from "../session/session-anonymizer";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { loadEntriesFromFile } from "../session/session-loader";
import { resolveSessionFileArg } from "./session-arg";

export interface AnonymizeCommandArgs {
	/** Session file path or id prefix (default: most recent for cwd). */
	session?: string;
	/** Output directory (default: `./<session-file-stem>.anon`). */
	out?: string;
}

export async function runAnonymizeCommand(args: AnonymizeCommandArgs): Promise<void> {
	const sourcePath = await resolveSessionFileArg(args.session, getProjectDir());
	const outDir = path.resolve(args.out ?? `${path.basename(sourcePath, ".jsonl")}.anon`);
	const records = await loadEntriesFromFile(sourcePath);
	const result = await anonymizeSessionTranscripts({
		header: (records.find(record => record.type === "session") as SessionHeader | undefined) ?? null,
		entries: records.filter((record): record is SessionEntry => record.type !== "session"),
		sessionFile: sourcePath,
	});
	for (const [name, content] of result.files) await Bun.write(path.join(outDir, name), content);

	const count = result.files.length;
	process.stdout.write(`Anonymized ${count} transcript${count === 1 ? "" : "s"} → ${outDir}\n`);
	if (result.subagentError) process.stdout.write(`Subagent transcripts unavailable: ${result.subagentError}\n`);
}
