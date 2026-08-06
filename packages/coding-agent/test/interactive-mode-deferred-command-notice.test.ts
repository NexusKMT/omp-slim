import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
};

let harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-deferred-notice-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Deferred notice", "user");
	let streaming = false;
	const session = {
		sessionManager,
		settings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		get isStreaming() {
			return streaming;
		},
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	const harness = {
		mode,
		tempDir,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
	harnesses.push(harness);
	return harness;
}

function noticeText(mode: InteractiveMode): string {
	return mode.deferredCommandContainer.render(120).join("\n");
}

function transcriptRowCount(mode: InteractiveMode): number {
	return mode.chatContainer.render(120).length;
}

function transcriptText(mode: InteractiveMode): string {
	return mode.chatContainer.render(120).join("\n");
}

afterEach(() => {
	for (const harness of harnesses) {
		harness.mode.stop();
		harness.tempDir.removeSync();
	}
	harnesses = [];
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InteractiveMode deferred command notice", () => {
	it("acknowledges a command deferred mid-turn without touching the transcript", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const transcriptBefore = transcriptRowCount(mode);

		mode.presentCommandOutput(new Text("usage panel", 1, 0));

		// The whole point of the anchored container: a mid-turn transcript mount
		// re-renders rows below the growing live block and duplicates them in
		// native scrollback (issues #4806/#6767). Assert on content as well as row
		// count, since a bare Spacer can leak without changing the count.
		expect(transcriptRowCount(mode)).toBe(transcriptBefore);
		expect(transcriptText(mode)).not.toContain("queued");
		expect(noticeText(mode)).toContain("1 command output queued");
		expect(noticeText(mode)).toContain("shown when the agent pauses");
	});

	it("counts commands rather than the components each one queues", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);

		// One command commonly queues a spacer plus its panel; that is still one
		// command from the user's point of view.
		mode.presentCommandOutput([new Text("spacer", 1, 0), new Text("usage panel", 1, 0)]);
		expect(noticeText(mode)).toContain("1 command output queued");

		mode.presentCommandOutput(new Text("advisor panel", 1, 0));
		expect(noticeText(mode)).toContain("2 command outputs queued");
	});

	it("clears the notice and mounts the panels once the turn settles", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		setStreaming(false);
		mode.flushPendingCommandOutput();

		expect(noticeText(mode)).toBe("");
		expect(mode.chatContainer.render(120).join("\n")).toContain("usage panel");
	});

	it("shows no notice when the agent is idle, since output mounts immediately", async () => {
		const { mode } = await createHarness();

		mode.presentCommandOutput(new Text("usage panel", 1, 0));

		expect(noticeText(mode)).toBe("");
		expect(mode.chatContainer.render(120).join("\n")).toContain("usage panel");
	});

	it("drops a stale notice when the session is reset while output is queued", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("usage panel", 1, 0));
		expect(noticeText(mode)).not.toBe("");

		mode.clearTransientSessionUi();

		expect(noticeText(mode)).toBe("");
	});
});
