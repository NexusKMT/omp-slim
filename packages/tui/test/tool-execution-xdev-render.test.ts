import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { XdevMountedRenderer } from "@oh-my-pi/pi-tui/tools/xdev";

/**
 * A `write xd://<tool>` card must render with the dispatched tool's own
 * renderer. Dispatch accepts mounted devices *and* active top-level tools
 * (`resolveXdevTool`), while the write card's renderer lookup used to be
 * gated on `mountedNames` alone — so an essential (top-level) extension tool
 * called through the device transport fell back to the generic args/output
 * card even though the identical native call renders its custom frame.
 */

const ui = () => ({
	requestRender: vi.fn(),
	requestComponentRender: vi.fn(),
	resetDisplay: vi.fn(),
});

/** Renderer-bearing device fixture. */
const probeTool = {
	name: "probe",
	label: "Probe",
	mergeCallAndResult: true,
	renderCall: () => new Text("PROBE-CALL", 0, 0),
	renderResult: () => new Text("PROBE-RESULT", 0, 0),
};

function writeToolWithXdev(xdev: {
	mountedNames: ReadonlySet<string>;
	tools: ReadonlyMap<string, XdevMountedRenderer>;
	isActive?: (name: string) => boolean;
}): AgentTool {
	return { name: "write", label: "Write", session: { xdev } } as unknown as AgentTool;
}

const xdevState = (mounted: string[], isActive: (name: string) => boolean) => ({
	mountedNames: new Set(mounted),
	tools: new Map<string, XdevMountedRenderer>([[probeTool.name, probeTool]]),
	isActive,
});

const dispatchResult = {
	content: [{ type: "text" as const, text: "42" }],
	details: {
		xdev: {
			tool: probeTool.name,
			mode: "execute" as const,
			args: { command: "Write-Output 42" },
			inner: { output: "42" },
		},
	},
};

function renderDeviceWrite(xdev: Parameters<typeof writeToolWithXdev>[0]): string {
	const component = new ToolExecutionComponent(
		"write",
		{ path: `xd://${probeTool.name}`, content: JSON.stringify({ command: "Write-Output 42" }) },
		{ useBuiltInRenderer: true },
		writeToolWithXdev(xdev),
		ui(),
	);
	component.updateResult(dispatchResult, false);
	return component.render(80).join("\n");
}

describe("write xd:// device card renderer resolution", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("delegates to an active top-level tool's renderer", () => {
		const rendered = renderDeviceWrite(xdevState([], name => name === probeTool.name));
		expect(rendered).toContain("PROBE-RESULT");
	});

	it("delegates to a mounted device's renderer", () => {
		const rendered = renderDeviceWrite(xdevState([probeTool.name], () => false));
		expect(rendered).toContain("PROBE-RESULT");
	});

	it("falls back to the generic card for a name that can neither be mounted nor dispatched", () => {
		const rendered = renderDeviceWrite(xdevState([], () => false));
		expect(rendered).not.toContain("PROBE-RESULT");
		expect(rendered).toContain("42");
	});
});
