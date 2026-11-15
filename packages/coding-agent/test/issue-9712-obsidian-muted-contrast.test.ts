import { describe, expect, test } from "bun:test";
import { relativeLuminance } from "@oh-my-pi/pi-utils";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";

const MIN_TEXT_CONTRAST = 4.5;

function contrastRatio(foreground: string | number, background: string | number): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	if (foregroundLuminance === undefined || backgroundLuminance === undefined) {
		throw new Error("Obsidian has an invalid muted text or background color");
	}
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

describe("Obsidian muted text contrast (#9712)", () => {
	test("usage limits remain readable on their backgrounds", async () => {
		const theme = await loadTheme("obsidian", { mode: "truecolor" });

		const muted = theme.getColorHex("muted");
		const surfaces: [string, string | number][] = [["usage/status", theme.getBgHex("statusLineBg")]];
		for (const [name, background] of surfaces) {
			expect(contrastRatio(muted, background), name).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
		}
	});
});
