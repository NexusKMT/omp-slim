/**
 * Install dependencies for optional features.
 */

import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { setupHelp as commandHelp } from "../cli/command-help";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const COMPONENTS: SetupComponent[] = ["python"];

export default class Setup extends Command {
	static description = commandHelp.description;
	static args = {
		component: Args.string({
			description: "Optional component to install",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			throw new CliUsageError("setup requires a COMPONENT (python)");
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
