import { describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
type Spy = Mock<(...args: unknown[]) => unknown>;

function createLoopContext(options: {
	isStreaming: boolean;
	isCompacting?: boolean;
	extensionCommandNames?: string[];
	onInputCallback?: (...args: never[]) => void;
}) {
	const extensionCommandNames = options.extensionCommandNames ?? [];
	const extensionRunner =
		extensionCommandNames.length > 0
			? {
					hasHandlers: () => false,
					getCommand: (name: string) => (extensionCommandNames.includes(name) ? {} : undefined),
				}
			: undefined;
	let loopPrompt: string | undefined = "original loop prompt";
	const setLoopPrompt = vi.fn((prompt: string) => {
		loopPrompt = prompt;
	});
	const prompt = vi.fn(async () => {});
	const editor = {
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: undefined,
		addToHistory: vi.fn(),
		setText: vi.fn(),
		getText: () => "",
		getExpandedText: () => "",
		clearDraft: vi.fn(),
		setCollapsedText: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: options.isStreaming,
			isCompacting: options.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner,
			customCommands: [],
			promptTemplates: [],
			prompt,
			maybeStartTitleGeneration: vi.fn(),
		},
		sessionManager: { putBlob: vi.fn() },
		loopModeEnabled: true,
		get loopPrompt() {
			return loopPrompt;
		},
		set loopPrompt(value: string | undefined) {
			loopPrompt = value;
		},
		setLoopPrompt,
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		handleBashCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		onInputCallback: options.onInputCallback,
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		focusedAgentId: undefined,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		setLoopPrompt,
		prompt,
		getLoopPrompt: () => loopPrompt,
		queueCompactionMessage: ctx.queueCompactionMessage as Spy,
		handleBashCommand: ctx.handleBashCommand as Spy,
	};
}

describe("loop mode interjections", () => {
	it("keeps the original loop prompt when steering mid-turn", async () => {
		const { ctx, setLoopPrompt, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("one-off correction");

		// One-off steer reaches the session but must not replace the loop body.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("adopts an idle submission as the new loop prompt", async () => {
		const onInputCallback = vi.fn();
		const { ctx, setLoopPrompt } = createLoopContext({ isStreaming: false, onInputCallback });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("new loop body");

		expect(setLoopPrompt).toHaveBeenCalledWith("new loop body");
		expect(onInputCallback).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt even while streaming", async () => {
		const { ctx, setLoopPrompt, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		// Mirror handleLoopCommand: enabling loop mode hands the inline prompt
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "inline loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 inline loop body");

		expect(setLoopPrompt).toHaveBeenCalledWith("inline loop body");
		expect(getLoopPrompt()).toBe("inline loop body");
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt queued during compaction", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
		});
		// Mirror handleLoopCommand: enabling loop mode hands the inline prompt
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "compact loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 compact loop body");

		expect(setLoopPrompt).toHaveBeenCalledWith("compact loop body");
		expect(getLoopPrompt()).toBe("compact loop body");
		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
	});

	it("does not arm the loop when the inline body is a local command", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, handleBashCommand } = createLoopContext({ isStreaming: false });
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher, where the bash branch consumes it.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "!echo hi");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 !echo hi");

		expect(handleBashCommand).toHaveBeenCalledWith("echo hi", false);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("does not arm the loop when the compacted body is a local command", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
			extensionCommandNames: ["ext-cmd"],
		});
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher, where it queues for compaction.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "/ext-cmd args");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 /ext-cmd args");

		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});
});
