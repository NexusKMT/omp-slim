import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

function createRuntime() {
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const settings = Settings.isolated();
	return {
		showModelSelector,
		switchSessionModel,
		showError,
		setText,
		settings,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: [],
					modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
				},
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model slash command", () => {
	it("opens the current model and thinking selector", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch sonnet:high fuzzy-resolves and switches session-only with the thinking suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch sonnet:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[1], "high");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch refuses retired role aliases", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch @smol", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: @smol");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
	});

	it("/switch unknown surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});

	it("completes the available main models with an explicit thinking suffix and tracks catalog changes", async () => {
		const first = createMockModel({ provider: "openai", id: "main-chat" }).model;
		const second = createMockModel({ provider: "anthropic", id: "other-chat" }).model;
		let available = [first];
		const focus: { agentId?: string } = {};
		const ctx = createInteractiveModeContext({
			get focusedAgentId() {
				return focus.agentId;
			},
			settings: Settings.isolated(),
			session: {
				scopedModels: [],
				modelRegistry: {
					getAvailable: () => available,
					getAll: () => available,
					getError: () => undefined,
				},
			},
		});
		const command = buildTuiBuiltinSlashCommands({ ctx }).find(item => item.name === "switch")!;
		const choices = await command.getArgumentCompletions?.("main:high");
		expect(choices?.map(item => item.value)).toEqual(["openai/main-chat:high "]);
		available = [second];
		expect((await command.getArgumentCompletions?.("other"))?.map(item => item.value)).toEqual([
			"anthropic/other-chat ",
		]);
		focus.agentId = "Worker";
		expect(await command.getArgumentCompletions?.("")).toBeNull();
	});
});
