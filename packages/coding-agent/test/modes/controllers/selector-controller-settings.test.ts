import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("persists queue-mode toggles globally from the settings panel", () => {
		const setSteeringMode = vi.fn();
		const setFollowUpMode = vi.fn();
		const setInterruptMode = vi.fn();
		const ctx = {
			session: { setSteeringMode, setFollowUpMode, setInterruptMode },
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("steeringMode", "one-at-a-time");
		controller.handleSettingChange("followUpMode", "one-at-a-time");
		controller.handleSettingChange("interruptMode", "wait");

		expect(setSteeringMode).toHaveBeenCalledWith("one-at-a-time", true);
		expect(setFollowUpMode).toHaveBeenCalledWith("one-at-a-time", true);
		expect(setInterruptMode).toHaveBeenCalledWith("wait", true);
	});
});
