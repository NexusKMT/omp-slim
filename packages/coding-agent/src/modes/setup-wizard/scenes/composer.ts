import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { ComposerShape } from "../../../config/settings-schema";
import { renderComposerShapePreview } from "../../components/composer-shape-preview";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const COMPOSER_SHAPES: readonly ComposerShape[] = ["box", "claude", "pi", "borderless"];

const COMPOSER_LABELS: Readonly<Record<ComposerShape, string>> = {
	box: "Rounded Box (Default)",
	claude: "Claude Code",
	pi: "Pi",
	borderless: "Borderless",
};

const COMPOSER_DESCRIPTIONS: Readonly<Record<ComposerShape, string>> = {
	box: "Status line integrated in top border, compact 2-line prompt",
	claude: "Full-width horizontal rules above and below, status line at bottom",
	pi: "Framed rounded box with prompt glyph, status line at bottom",
	borderless: "Clean prompt glyph with status line at bottom, no box borders",
};

const COMPOSER_ITEMS: readonly SelectItem[] = COMPOSER_SHAPES.map((shape, index) => ({
	value: shape,
	label: `${index + 1}  ${COMPOSER_LABELS[shape]}`,
	description: COMPOSER_DESCRIPTIONS[shape],
}));

class ComposerSceneController implements SetupSceneController {
	title = "Choose composer shape";
	subtitle = "Pick the prompt and status line layout for your workflow.";
	#selectList: SelectList;
	#currentShape: ComposerShape = "box";
	#committing = false;
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		const configuredShape = host.ctx.settings.get("composer.shape") as ComposerShape;
		const initialShape = COMPOSER_SHAPES.includes(configuredShape) ? configuredShape : "box";
		this.#currentShape = initialShape;
		const initialIndex = Math.max(0, COMPOSER_SHAPES.indexOf(initialShape));

		const selectListTheme = getSelectListTheme();
		this.#selectList = new SelectList(COMPOSER_ITEMS, COMPOSER_ITEMS.length, selectListTheme);
		this.#selectList.setSelectedIndex(initialIndex);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value as ComposerShape);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value as ComposerShape);
		};
		this.#selectList.onCancel = () => {
			// Esc skips the scene without saving; the configured shape stays untouched.
			this.host.finish("skipped");
		};
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data >= "1" && data <= "4" ? Number(data) - 1 : -1;
		if (quickIndex >= 0 && quickIndex < COMPOSER_ITEMS.length) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(COMPOSER_SHAPES[quickIndex] ?? "box");
			return;
		}
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const listLine = line - this.#listRowStart;
		routeSelectListMouse(this.#selectList, event, listLine);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const budget = maxLines ?? Number.POSITIVE_INFINITY;
		const lines = [theme.fg("muted", "Select a layout; live preview updates below. Press Enter to confirm."), ""];

		const previewLines = renderComposerShapePreview(this.#currentShape, width);
		if (budget - lines.length - previewLines.length - 2 >= COMPOSER_ITEMS.length) {
			lines.push(theme.fg("muted", "Preview:"), ...previewLines, "");
		}

		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #commit(shape: ComposerShape): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		try {
			this.host.ctx.settings.set("composer.shape", shape);
			await this.host.ctx.settings.flush();
		} finally {
			this.host.finish("done");
		}
	}

	#preview(shape: ComposerShape): void {
		this.#currentShape = shape;
		this.host.requestRender();
	}
}

export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	minVersion: 2,
	mount: host => new ComposerSceneController(host),
};
