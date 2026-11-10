/**
 * Search HTTP engines.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { searchHelp as commandHelp } from "../cli/command-help";
import { runSearchCommand, type SearchCommandArgs } from "../cli/web-search-cli";

const RECENCY: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

export default class Search extends Command {
	static description = commandHelp.description;
	static aliases = ["q", "web-search"];

	static args = {
		query: Args.string({ description: "Search query text", required: false, multiple: true }),
	};

	static flags = {
		engine: Flags.string({ description: "HTTP search engine" }),
		recency: Flags.string({ description: "Recency filter", options: RECENCY }),
		limit: Flags.integer({ char: "l", description: "Max results to return" }),
		compact: Flags.boolean({ description: "Render condensed output" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			engine: flags.engine as SearchCommandArgs["engine"],
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
		};

		await runSearchCommand(cmd);
	}
}
