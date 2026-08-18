import { describe, expect, it } from "bun:test";
import { formatTitleConversationContext } from "../../src/tiny/message-preproc";
import { skillPromptTitleInput, titleTextFromSkillPrompt } from "../../src/session/skill-title-input";

describe("skillPromptTitleInput", () => {
	it("uses the operator /skill chip when present", () => {
		expect(
			skillPromptTitleInput({
				name: "implement",
				args: "issues/07-manual-llm.md",
				queueChipText: "/skill:implement issues/08-app-settings.md",
			}),
		).toBe("/skill:implement issues/08-app-settings.md");
	});

	it("reconstructs /skill:name args when the chip was stripped", () => {
		expect(skillPromptTitleInput({ name: "implement", args: "issues/07-manual-llm.md 创建临时工作树实现" })).toBe(
			"/skill:implement issues/07-manual-llm.md 创建临时工作树实现",
		);
	});
});

describe("titleTextFromSkillPrompt", () => {
	it("reads args from a user skill-prompt and ignores expanded body fields", () => {
		const text = titleTextFromSkillPrompt({
			role: "custom",
			customType: "skill-prompt",
			attribution: "user",
			details: {
				name: "implement",
				path: "/tmp/implement/SKILL.md",
				args: "issues/07-manual-llm.md",
				lineCount: 20,
			},
		});
		expect(text).toBe("/skill:implement issues/07-manual-llm.md");
	});

	it("ignores autoloaded skill prompts", () => {
		expect(
			titleTextFromSkillPrompt({
				role: "custom",
				customType: "skill-prompt",
				attribution: "agent",
				details: { name: "implement", args: "issues/07-manual-llm.md" },
			}),
		).toBeUndefined();
	});
});

describe("replan title envelope", () => {
	it("puts skill args in the user turn and keeps assistant text", () => {
		const text = titleTextFromSkillPrompt({
			role: "custom",
			customType: "skill-prompt",
			attribution: "user",
			details: {
				name: "implement",
				args: "issues/07-manual-llm.md 创建临时工作树实现",
			},
		});
		const context = formatTitleConversationContext([
			{ role: "user", text },
			{ role: "assistant", text: "先读 implement 技能、ticket 07" },
		]);

		expect(context).toContain("07-manual-llm.md");
		expect(context).toContain("ticket 07");
		expect(context).not.toContain("SKILL.md");
	});
});
