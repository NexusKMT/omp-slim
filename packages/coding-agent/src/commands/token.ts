/** Read the configured API key for one explicit provider. */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { tokenHelp as commandHelp } from "../cli/command-help";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";

export default class Token extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({ description: "Provider ID from models.yml", required: true }),
	};
	static examples = ["omp token my-provider"];

	async run(): Promise<void> {
		const { args } = await this.parse(Token);
		const provider = args.provider ?? "";
		const authStorage = await discoverAuthStorage();
		try {
			const registry = new ModelRegistry(authStorage);
			const apiKey = await registry.getApiKeyForProvider(provider);
			if (!isAuthenticated(apiKey)) {
				process.stderr.write(`${chalk.red(`No API key configured for provider "${provider}".`)}\n`);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}
