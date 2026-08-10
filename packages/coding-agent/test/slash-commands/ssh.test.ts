import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/ssh completion", () => {
	it("shows the config scope in the add command hint", () => {
		const ssh = BUILTIN_SLASH_COMMANDS.find(command => command.name === "ssh");

		expect(ssh?.getInlineHint?.("add ")).toBe(
			"<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
		);
	});
});
