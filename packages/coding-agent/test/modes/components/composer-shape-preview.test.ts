import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COMPOSER_SHAPE_VALUES, type ComposerShape } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ComposerShapePreview,
	renderComposerShapePreview,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-shape-preview";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme, setTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	const shapes: ComposerShape[] = [...COMPOSER_SHAPE_VALUES];

	it.each(shapes)("renders %s shape preview without throwing in dark theme", async (shape: ComposerShape) => {
		await setTheme("dark");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it.each(shapes)("renders %s shape preview without throwing in light theme", async (shape: ComposerShape) => {
		await setTheme("light");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it("updates preview when setValue is called on ComposerShapePreview component", async () => {
		await setTheme("dark");
		let renderRequested = false;
		const preview = new ComposerShapePreview("box", {
			requestRender: () => {
				renderRequested = true;
			},
		});
		const initialLines = preview.render(80);
		expect(initialLines.some(l => l.includes("Preview:"))).toBe(true);

		preview.setValue("claude");
		expect(renderRequested).toBe(true);
		const nextLines = preview.render(80);
		expect(nextLines.some(l => l.includes("Preview:"))).toBe(true);
	});

	it("borrows status rows from the live status source per shape layout", async () => {
		await setTheme("dark");
		const calls: string[] = [];
		const status = {
			getTopBorder: (width: number) => {
				calls.push(`top:${width}`);
				return { content: "TOPBAR", width: 6 };
			},
			getStandaloneTopBorder: (width: number) => {
				calls.push(`chip:${width}`);
				return { content: "CHIP", width: 4 };
			},
			renderBottomBar: (_width: number, groups: "left" | "full") => {
				calls.push(`bottom:${groups}`);
				return `BOTTOM-${groups.toUpperCase()}`;
			},
		};

		const box = renderComposerShapePreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR"); // embedded in the top border
		expect(box).not.toContain("BOTTOM"); // box has no standalone bottom bar

		const claude = renderComposerShapePreview("claude", 80, status).join("\n");
		expect(claude).toContain("CHIP"); // right group chips onto the top rule
		expect(claude).toContain("BOTTOM-LEFT"); // left group only on the bottom bar

		const pi = renderComposerShapePreview("pi", 80, status).join("\n");
		expect(pi).not.toContain("CHIP");
		expect(pi).toContain("BOTTOM-FULL"); // both groups on the bottom bar

		const borderless = renderComposerShapePreview("borderless", 80, status).join("\n");
		expect(borderless).toContain("BOTTOM-FULL");
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);

		for (const ch of "composer shape") selector.handleInput(ch);
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});
});
