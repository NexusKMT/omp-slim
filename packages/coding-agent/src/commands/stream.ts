import * as path from "node:path";
import { DEFAULT_STREAM_URL, STREAM_CHANNEL_NAME_RE, STREAM_TITLE_MAX } from "@oh-my-pi/pi-wire";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { streamHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { resolveStreamUrls, runStreamConsole, type StreamUrls } from "../stream/streamer";

export default class Stream extends Command {
	static description = commandHelp.description;

	static args = {
		channel: Args.string({
			description: "Public channel name (lowercase letters, numbers, and dashes)",
			required: true,
		}),
	};

	static flags = {
		title: Flags.string({ description: "Stream title (defaults to the current directory name)" }),
		server: Flags.string({ description: "Stream server base URL (overrides stream.serverUrl)" }),
	};

	static examples = [
		"omp stream my-project",
		'omp stream my-project --title "Building a parser"',
		"omp stream my-project --server https://live.example.com",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Stream);
		const channel = args.channel ?? "";
		if (!STREAM_CHANNEL_NAME_RE.test(channel)) {
			throw new CliUsageError(
				"channel must be 1-32 lowercase letters, numbers, or dashes, and must start and end with a letter or number",
			);
		}
		const cwd = process.cwd();
		const title = flags.title ?? path.basename(cwd);
		if (title.length > STREAM_TITLE_MAX) {
			throw new CliUsageError(`title must be at most ${STREAM_TITLE_MAX} characters`);
		}
		const settings = await Settings.loadReadOnly({ cwd });
		let urls: StreamUrls;
		try {
			urls = resolveStreamUrls(flags.server ?? settings.get("stream.serverUrl") ?? DEFAULT_STREAM_URL, channel);
		} catch (error) {
			throw new CliUsageError(error instanceof Error ? error.message : String(error));
		}
		try {
			const exitCode = await runStreamConsole({
				projectDir: cwd,
				channel,
				title,
				viewerUrl: urls.viewerUrl,
				hostUrl: urls.hostUrl,
			});
			if (exitCode !== 0) process.exitCode = exitCode;
		} catch (error) {
			process.stderr.write(`stream: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
