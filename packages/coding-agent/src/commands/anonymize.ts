/**
 * Write a shareable, anonymized copy of a session and its subagent transcripts.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runAnonymizeCommand } from "../cli/anonymize-cli";
import { anonymizeHelp as commandHelp } from "../cli/command-help";

export default class Anonymize extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({ description: "Session file path or id prefix (default: most recent for cwd)" }),
	};
	static flags = {
		out: Flags.string({ char: "o", description: "Output directory (default: ./<session-file>.anon)" }),
	};

	static examples = [
		"omp anonymize",
		"omp anonymize 01a0285c -o ./bug-report",
		"omp anonymize ~/.omp/agent/sessions/--work-pi--/session.jsonl",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Anonymize);
		await runAnonymizeCommand({ session: args.session, out: flags.out });
	}
}
