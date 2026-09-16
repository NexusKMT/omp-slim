import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

// Regression coverage for #12238: a corrupted session file makes the close-time
// atomic rewrite fail closed with SessionWriteConflictError (it refuses to
// clobber bytes another writer added). The guard is correct, but shutdown() used
// to swallow the error, reset its own latch, and return without ever exiting —
// so the process stayed alive and every further Ctrl+C repeated the identical
// failure. The escape hatch is a second Ctrl+C that exits without writing the
// session log.
describe("InteractiveMode shutdown when the session write conflicts (#12238)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let quitSpy: ReturnType<typeof vi.spyOn>;
	let showErrorSpy: ReturnType<typeof vi.spyOn>;
	let disposeSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-shutdown-conflict-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		showErrorSpy = vi.spyOn(mode, "showError").mockImplementation(() => {});
		// The failure originates inside session.dispose() -> sessionManager.close().
		// The real dispose() calls beginDispose() as its first step (setting
		// isDisposed) and only then does the close-time rewrite fail, so mirror that
		// ordering: beginDispose(), then reject. This is what makes the failure a
		// dispose-stage one (non-retryable) rather than a pre-dispose flush failure.
		disposeSpy = vi.spyOn(session, "dispose").mockImplementation(async () => {
			session.beginDispose();
			throw new SessionWriteConflictError("/tmp/session.jsonl", 1098468, 1098948);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("surfaces the write conflict on the first attempt without force-exiting", async () => {
		await mode.shutdown();

		const message = showErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(message).toContain("Could not close session");
		expect(message).toContain("Ctrl+C");
		// Must not force-exit yet: the user gets one chance to see the error.
		expect(quitSpy).not.toHaveBeenCalled();
		// The latch is cleared so a second Ctrl+C can re-enter shutdown().
		expect(mode.isShuttingDown).toBe(false);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("exits without writing the session log on the second attempt", async () => {
		await mode.shutdown();
		await mode.shutdown();

		// The second Ctrl+C is the escape hatch: it quits rather than re-running
		// the teardown that already failed once (dispose stays memoized at 1 call).
		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
