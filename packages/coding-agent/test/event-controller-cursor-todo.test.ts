import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

interface Fixture {
	ctx: InteractiveModeContext;
	controller: EventController;
	showWarning: Mock<InteractiveModeContext["showWarning"]>;
}

function createFixture(): Fixture {
	const showWarning = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		session: { isAborting: false },
		updateEditorTopBorder: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		viewSession: { isStreaming: false, getToolByName: () => undefined },
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: { addChild: vi.fn(), removeChild: vi.fn(), isBlockUncommitted: () => false },
		toolOutputExpanded: false,
		setTodos: vi.fn(),
		present: vi.fn(),
		showWarning,
	} as unknown as InteractiveModeContext;
	return { ctx, controller: new EventController(ctx), showWarning };
}

function todoFailure(text: string): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId: "todo-1",
		toolName: "todo",
		isError: true,
		result: { content: [{ type: "text", text }] },
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

describe("EventController + Cursor todo bridge", () => {
	it("sanitizes provider error text before it reaches the status line", async () => {
		// The bridge forwards the server's error string verbatim, so this text is
		// untrusted terminal input. Raw tabs punch holes in the single-line status
		// area and an unbounded string overflows it.
		const f = createFixture();

		await f.controller.handleEvent(
			todoFailure(`\u001b[31mrejected:\u001b[0m\tid 4\r\n\tconflicts with ${"x".repeat(400)}`),
		);

		expect(f.showWarning).toHaveBeenCalledTimes(1);
		const message = f.showWarning.mock.calls[0]![0] as string;
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\n");
		// ANSI and other C0/C1 controls reach the terminal verbatim through
		// `Text` and can repaint outside the row, so they must be gone too.
		expect(message).not.toContain("\u001b");
		expect(message).not.toContain("\r");
		// The prefix is ours and fixed; only the untrusted tail is bounded.
		expect(message.startsWith("Todo update failed: ")).toBe(true);
		expect(Bun.stringWidth(message.slice("Todo update failed: ".length))).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("keeps the standalone hint when the failure carries no text", async () => {
		// Without a detail the warning must still say the panel may be stale —
		// dropping to a bare "Todo update failed" hides that local state diverged.
		const f = createFixture();

		await f.controller.handleEvent(todoFailure(""));

		expect(f.showWarning).toHaveBeenCalledWith("Todo update failed. Progress may be stale until todo succeeds.");
	});
});
