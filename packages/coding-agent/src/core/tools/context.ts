import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { CustomToolContext } from "../custom-tools/types";
import type { ExtensionUIContext } from "../extensions/types";

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
	}
}

export interface ToolContextStore {
	getContext(): AgentToolContext;
	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	setToolNames(names: string[]): void;
}

export function createToolContextStore(getBaseContext: () => CustomToolContext): ToolContextStore {
	let uiContext: ExtensionUIContext | undefined;
	let hasUI = false;
	let toolNames: string[] = [];

	return {
		getContext: () => ({
			...getBaseContext(),
			ui: uiContext,
			hasUI,
			toolNames,
		}),
		setUIContext: (context, uiAvailable) => {
			uiContext = context;
			hasUI = uiAvailable;
		},
		setToolNames: (names) => {
			toolNames = names;
		},
	};
}
