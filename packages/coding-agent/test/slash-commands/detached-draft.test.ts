import { describe, expect, it, type Mock, vi } from "bun:test";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

interface Harness {
	ctx: InteractiveModeContext;
	handleTraceCommand: Mock<() => Promise<void>>;
	showError: Mock<(message: string) => void>;
	editorText(): string;
}

function createHarness(draft: string): Harness {
	let text = draft;
	const handleTraceCommand = vi.fn(async () => {});
	const showError = vi.fn((_message: string) => {});
	const ctx = createInteractiveModeContext({
		editor: {
			getText: () => text,
			setText: (next: string) => {
				text = next;
			},
		},
		handleTraceCommand,
		showError,
	});
	return { ctx, handleTraceCommand, showError, editorText: () => text };
}

const COMMANDS: ReadonlyArray<readonly [string, (h: Harness) => void]> = [
	["/trace", h => expect(h.handleTraceCommand).toHaveBeenCalledTimes(1)],
	["/skills search", h => expect(h.showError).toHaveBeenCalledWith("Usage: /skills search <query>")],
];

describe("builtin commands and detached drafts", () => {
	it.each(COMMANDS)("%s leaves a newer draft alone once its own draft was detached", async (submitted, ran) => {
		const h = createHarness("newer draft");

		await executeBuiltinSlashCommand(submitted, { ctx: h.ctx, draftDetached: true });

		ran(h);
		expect(h.editorText()).toBe("newer draft");
	});

	it.each(COMMANDS)(
		"%s still clears its own draft from the editor when it was not detached",
		async (submitted, ran) => {
			const h = createHarness(submitted);

			await executeBuiltinSlashCommand(submitted, { ctx: h.ctx });

			ran(h);
			expect(h.editorText()).toBe("");
		},
	);
});
