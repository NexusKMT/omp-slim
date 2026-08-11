import type { Component } from "@oh-my-pi/pi-tui";

/** A transcript component whose rows belong to model/tool activity. */
export interface ToolActivityComponent {
	setToolActivityVisible(visible: boolean): void;
}

/** Narrows mounted transcript children to the reversible tool-activity contract. */
export function isToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return typeof (component as Partial<ToolActivityComponent>).setToolActivityVisible === "function";
}
