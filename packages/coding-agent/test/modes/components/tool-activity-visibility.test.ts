import { beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TodoReminderComponent } from "@oh-my-pi/pi-coding-agent/modes/components/todo-reminder";
import { ToolActivityContainer } from "@oh-my-pi/pi-coding-agent/modes/components/tool-activity-container";
import { ToolActivityWarningComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-activity-warning";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ttsr-notification";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const darkTheme = await getThemeByName("dark");

describe("tool activity visibility", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("hides and restores mounted activity blocks without losing their content", () => {
		const rule: Rule = {
			name: "ts-no-tiny-functions",
			path: "/rules/ts-no-tiny-functions.md",
			content: "Inline tiny wrappers.",
			_source: {
				provider: "test",
				providerName: "Test",
				path: "/rules/ts-no-tiny-functions.md",
				level: "project",
			},
		};
		const components = [
			{ component: new TtsrNotificationComponent([rule]), text: "ts-no-tiny-functions" },
			{
				component: new TodoReminderComponent([{ content: "finish the task", status: "in_progress" }], 1, 3),
				text: "finish the task",
			},
			{
				component: new ToolActivityContainer(new ToolActivityWarningComponent("Warning: tool failed")),
				text: "tool failed",
			},
		] as const;

		for (const { component, text } of components) {
			expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain(text);
			component.setToolActivityVisible(false);
			expect(stripVTControlCharacters(component.render(120).join("\n"))).toBe("");
			component.setToolActivityVisible(true);
			expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain(text);
		}
	});
});
