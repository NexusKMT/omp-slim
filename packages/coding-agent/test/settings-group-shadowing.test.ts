import { describe, expect, it } from "bun:test";
import { dropSettingsGroupShadows } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("dropSettingsGroupShadows", () => {
	it("drops a non-object leaf that would shadow a settings group", () => {
		// `.claude/settings.json` is shared with other tools; Claude Code's own
		// `"tui": "fullscreen"` must not replace omp's whole `tui.*` group.
		const result = dropSettingsGroupShadows({ tui: "fullscreen" }, "/proj/.claude/settings.json");
		expect(result).toEqual({});
	});

	it("keeps well-formed nested objects for a settings group", () => {
		const result = dropSettingsGroupShadows({ tui: { resizeScrollback: "preserve" } }, "/proj/.claude/settings.json");
		expect(result).toEqual({ tui: { resizeScrollback: "preserve" } });
	});

	it("drops nested non-object shadows without discarding valid siblings", () => {
		const result = dropSettingsGroupShadows(
			{ github: { cache: "nonsense" }, autoResume: true },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({ github: {}, autoResume: true });
	});

	it("preserves the scalar primary model setting", () => {
		const result = dropSettingsGroupShadows({ model: "anthropic/claude-sonnet-4-5" }, "/proj/.omp/settings.json");
		expect(result).toEqual({ model: "anthropic/claude-sonnet-4-5" });
	});
	it("passes unknown keys through untouched", () => {
		const result = dropSettingsGroupShadows(
			{ permissions: { allow: ["Bash"] }, $schema: "https://json.schemastore.org/claude-code-settings.json" },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({
			permissions: { allow: ["Bash"] },
			$schema: "https://json.schemastore.org/claude-code-settings.json",
		});
	});

	it("preserves arrays at non-group paths", () => {
		const result = dropSettingsGroupShadows(
			{ disabledProviders: ["provider-a", "provider-b"] },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({ disabledProviders: ["provider-a", "provider-b"] });
	});
});
