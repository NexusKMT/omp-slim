import { describe, expect, it } from "bun:test";
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";
import { commands } from "../src/cli-commands";

const METADATA_KEYS = [
	"description",
	"hidden",
	"flags",
	"args",
	"examples",
] as const satisfies readonly (keyof CommandMetadata)[];

describe("CLI command help metadata", () => {
	it("is complete and matches every loaded command", async () => {
		for (const entry of commands) {
			const help = entry.help;
			expect(help, `${entry.name} must provide static help metadata`).toBeDefined();
			if (!help) continue;

			const Command = await entry.load();
			for (const key of METADATA_KEYS) {
				if (help[key] !== undefined) {
					const expected: unknown = help[key];
					const actual: unknown = Command[key];
					expect(expected, `${entry.name}.${key} drifted from its command class`).toEqual(actual);
				}
			}
		}
	});
});
