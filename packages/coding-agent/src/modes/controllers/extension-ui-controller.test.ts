import { describe, expect, it, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../extensibility/extensions";
import { AskDialogComponent } from "../components/ask-dialog";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	const setFocus = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			setFocus,
			terminal: { rows: 40 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		setFocus,
		controller,
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});
