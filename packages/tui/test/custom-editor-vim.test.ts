import { beforeAll, describe, expect, it } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

const ESC = "\x1b";

function makeEditor(vim: boolean): { editor: CustomEditor; state: { escapes: number } } {
	const editor = new CustomEditor(getEditorTheme());
	const state = { escapes: 0 };
	editor.onEscape = () => {
		state.escapes++;
	};
	editor.setVimMode(vim);
	return { editor, state };
}

describe("CustomEditor vim mode", () => {
	beforeAll(() => {
		initTheme();
	});

	it("leaves Escape to the app interrupt when vim mode is off", () => {
		const { editor, state } = makeEditor(false);
		editor.setText("draft");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(1);
	});

	it("spends the first Escape leaving insert mode instead of interrupting", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("draft");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(0);
		expect(editor.vimMode).toBe("normal");
	});

	it("gives Escape back to the app once normal mode is quiet", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("draft");
		editor.handleInput(ESC);
		editor.handleInput(ESC);
		expect(state.escapes).toBe(1);
		expect(editor.getText()).toBe("draft");
	});

	it("spends Escape cancelling a visual selection before interrupting", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("alfa beta");
		editor.handleInput(ESC);
		editor.handleInput("v");
		editor.handleInput("h");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(0);
		expect(editor.vimMode).toBe("normal");
		expect(editor.getText()).toBe("alfa beta");
	});
});
