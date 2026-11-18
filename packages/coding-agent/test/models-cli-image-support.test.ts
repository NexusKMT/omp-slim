import { describe, expect, it } from "bun:test";
import { MODEL_KINDS } from "@oh-my-pi/pi-ai/types";
import Models from "@oh-my-pi/pi-coding-agent/commands/models";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = { bin: "omp", version: "test", commands: new Map() };

describe("omp models kind filtering", () => {
	it("accepts every advertised kind and rejects invalid values", async () => {
		for (const kind of [...MODEL_KINDS, "all"]) {
			const command = new Models(["--kind", kind], TEST_CONFIG);
			const parsed = await command.parse(Models);
			expect(parsed.flags.kind).toBe(kind);
		}

		const defaults = await new Models([], TEST_CONFIG).parse(Models);
		expect(defaults.flags.kind).toBe("chat");

		const invalid = new Models(["--kind", "hologram"], TEST_CONFIG);
		await expect(invalid.parse(Models)).rejects.toThrow(
			`Expected --kind to be one of: ${[...MODEL_KINDS, "all"].join(", ")}; got "hologram"`,
		);
	});
});
