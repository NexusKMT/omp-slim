import { Text } from "@oh-my-pi/pi-tui";
import type { ToolActivityComponent } from "./tool-activity";

/** A tool-originated warning that follows the reversible activity toggle. */
export class ToolActivityWarningComponent extends Text implements ToolActivityComponent {
	#visible = true;

	constructor(message: string) {
		super(message, 1, 0);
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#visible) return [];
		return super.render(width);
	}
}
