import { describe, expect, it } from "bun:test";
import { compositeLineAt } from "@oh-my-pi/pi-tui/render/composite";
import * as caShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import * as tuiShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-tui-shim";

// Upstream pi-coding-agent exports `parseSkillBlock` from its package root
// (src/core/agent-session.ts) and upstream pi-tui exports `compositeTuiLine`
// from its package root. omp folds skill invocation into its own hook
// pipeline (no parser exported) and renamed the composite helper
// `compositeLineAt` under `@oh-my-pi/pi-tui/render/composite`, so named
// imports of either from the aliased roots tripped Bun's static
// "Export named X not found" check (observed consumer: `pi-optchat`, which
// uses `parseSkillBlock` to match journaled skill invocations and
// `compositeTuiLine` to overlay its agent-view status line).
describe("legacy shim upstream-root bridges", () => {
	it("parseSkillBlock parses a skill block with its optional user message", () => {
		const parsed = caShim.parseSkillBlock('<skill name="commit" location="/skills/commit.md">\nbody text\n</skill>');
		expect(parsed).toEqual({
			name: "commit",
			location: "/skills/commit.md",
			content: "body text",
			userMessage: undefined,
		});
		const withMessage = caShim.parseSkillBlock(
			'<skill name="review" location="/skills/review.md">\nbody\n</skill>\n\nuser asked for review',
		);
		expect(withMessage?.userMessage).toBe("user asked for review");
		expect(caShim.parseSkillBlock("plain text")).toBeNull();
		expect(caShim.parseSkillBlock('<skill name="x" location="y">no trailing newline</skill>')).toBeNull();
	});

	it("compositeTuiLine aliases omp's compositeLineAt exactly", () => {
		expect(typeof tuiShim.compositeTuiLine).toBe("function");
		const base = "abcdefgh";
		// compositeLineAt embeds ANSI reset codes around the overlay, so assert
		// against the aliased implementation rather than a plain-string literal.
		expect(tuiShim.compositeTuiLine(base, "XY", 2, 2, 8)).toBe(compositeLineAt(base, "XY", 2, 2, 8));
		expect(tuiShim.compositeTuiLine(base, "TOOLONG", 0, 3, 8)).toBe(compositeLineAt(base, "TOOLONG", 0, 3, 8));
	});
});
