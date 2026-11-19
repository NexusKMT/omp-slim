import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("declarative subcommand completion", () => {
	it("gives the selected dropdown item the same ghost text as the closed-dropdown hint", async () => {
		const plugins = BUILTIN_SLASH_COMMANDS.find(command => command.name === "plugins");
		const items = await plugins?.getArgumentCompletions?.("en");
		const inlineHint = plugins?.getInlineHint?.("en") ?? undefined;

		expect(inlineHint).toBeTruthy();
		expect(items?.map(item => item.hint)).toEqual([inlineHint]);
	});
});
