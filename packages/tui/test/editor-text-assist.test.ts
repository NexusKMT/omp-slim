import { describe, expect, it } from "bun:test";
import { Editor, type EditorTextAssistProvider } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

describe("Editor text assistance", () => {
	it("shows and accepts word completion without an autocomplete provider", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) =>
				(lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null,
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		expect(editor.render(40).join("\n")).toContain("er");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("The weather");
	});

	it("applies autocorrection only after the provider returns a boundary replacement", () => {
		const assist: EditorTextAssistProvider = {
			tryAutocorrect: textBeforeCursor =>
				textBeforeCursor.endsWith("teh ") ? { replaceLen: 4, insert: "the " } : null,
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("I typed teh");

		editor.handleInput(" ");

		expect(editor.getText()).toBe("I typed the ");
	});
});
