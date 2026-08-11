import { type Component, Container } from "@oh-my-pi/pi-tui";
import type { ToolActivityComponent } from "./tool-activity";

/** Keeps model/tool activity mounted while making its rows reversible. */
export class ToolActivityContainer extends Container implements ToolActivityComponent {
	#visible = true;

	constructor(component: Component | Component[]) {
		super();
		if (Array.isArray(component)) {
			for (const child of component) this.addChild(child);
		} else {
			this.addChild(component);
		}
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
