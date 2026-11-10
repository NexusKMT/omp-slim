import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const SHARED_CWD = "/tmp/input-controller-internal-url-caller";

function registerSession(id: string, kind: "main" | "sub"): AgentSession {
	const session = {
		sessionManager: {
			getCwd: () => SHARED_CWD,
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getArtifactsDir: () => null,
			getSeanceSourceArtifactsDir: () => null,
		},
		settings: Settings.isolated(),
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind,
		...(kind === "sub" ? { parentId: "controller-main" } : {}),
		session,
		sessionFile: null,
	});
	return session;
}

describe("InputController autocomplete caller binding", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("completes internal URLs for the session the prompt is submitted to", async () => {
		// Both sessions live in one cwd, so cwd alone cannot name the caller.
		const main = registerSession("controller-main", "main");
		const child = registerSession("controller-child", "sub");

		let viewSession = main;
		const ctx = {
			get viewSession() {
				return viewSession;
			},
			session: main,
			sessionManager: main.sessionManager,
			settings: main.settings,
			keybindings: KeybindingsManager.inMemory(),
		} as unknown as InteractiveModeContext;
		const provider = new InputController(ctx).createAutocompleteProvider([], SHARED_CWD);

		vi.spyOn(InternalUrlRouter.instance(), "complete").mockImplementation(async (_scheme, _query, context) =>
			context?.sessionId ? [{ value: context.sessionId }] : [],
		);
		const line = "read history://";
		const forMain = await provider.getSuggestions([line], 0, line.length);
		expect(forMain?.items.map(item => item.value) ?? []).toContain("history://controller-main");

		// Focusing the child re-points editor submission and completion at it.
		viewSession = child;
		const forChild = await provider.getSuggestions([line], 0, line.length);
		expect(forChild?.items.map(item => item.value) ?? []).toContain("history://controller-child");
	});
});
