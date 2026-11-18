import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { execUrlProtocol } from "../helpers/exec-url-protocol";

beforeEach(() => {
	InternalUrlRouter.instance().register(execUrlProtocol);
});

afterEach(() => {
	InternalUrlRouter.instance().unregister(execUrlProtocol.scheme);
});

// Minimal ToolSession stub (block-images.test.ts shape). Approval functions are
// pure over their args, and the write-execute selector reject throws before any
// session/remote access, so no real cwd/fs is needed.
function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function callApproval(tool: { approval?: unknown }, args: unknown): string {
	const approval = tool.approval;
	if (typeof approval !== "function") throw new Error("expected a dynamic approval function");
	return approval(args) as string;
}

describe("execfs:// tools require exec-tier approval", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("read: execfs:// targets are exec, local paths stay read", () => {
		const tool = new ReadTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "execfs://icaro/etc/hostname" })).toBe("exec");
		expect(callApproval(tool, { path: "/etc/hostname" })).toBe("read");
		expect(callApproval(tool, { path: "local://notes" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("grep: an execfs:// entry flattened into a delimited path still trips exec", () => {
		const tool = new GrepTool(createTestToolSession(os.tmpdir()));
		// The delimited string is one entry at approval time (expansion happens
		// later), so an anchored check would miss it — the substring scan must not.
		expect(callApproval(tool, { path: "src,execfs://icaro/etc/hosts" })).toBe("exec");
		expect(callApproval(tool, { path: "src;execfs://icaro/etc/hosts" })).toBe("exec");
		// Unvalidated args may still carry a list or the legacy `paths` key.
		expect(callApproval(tool, { path: ["src", "execfs://icaro/etc/hosts"] })).toBe("exec");
		expect(callApproval(tool, { paths: "src,execfs://icaro/etc/hosts" })).toBe("exec");
		expect(callApproval(tool, { path: '["src","execfs:\\/\\/icaro\\/etc\\/hosts"]' })).toBe("exec");
		expect(callApproval(tool, { path: "src,lib" })).toBe("read");
		expect(callApproval(tool, { path: "src" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it.each([
		["find", (session: ToolSession) => new FindTool(session)],
		["glob", (session: ToolSession) => new GlobTool(session)],
		["ast_grep", (session: ToolSession) => new AstGrepTool(session)],
	])("%s: an execfs:// path is exec, local paths stay read", (_name, create) => {
		const tool = create(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "execfs://icaro/etc" })).toBe("exec");
		expect(callApproval(tool, { path: "src,execfs://icaro/etc" })).toBe("exec");
		expect(callApproval(tool, { path: "src" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("write: execfs:// is exec even when wrapped in a hashline header", () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "execfs://icaro/tmp/x" })).toBe("exec");
		// A pasted `[path#TAG]` wrapper must not let a remote write dodge the exec tier.
		expect(callApproval(tool, { path: "[execfs://icaro/tmp/x#ABCD]" })).toBe("exec");
		expect(callApproval(tool, { path: "/tmp/local-file.txt" })).toBe("write");
	});
});

describe("write rejects execfs:// line-range/malformed selectors before accessing the resource", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("execute throws on a line-range or malformed selector without invoking the handler", async () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		await expect(tool.execute("w-range", { path: "execfs://icaro/tmp/f:1-20", content: "x" })).rejects.toThrow(
			/whole file/,
		);
		await expect(tool.execute("w-malformed", { path: "execfs://icaro/tmp/f:-10", content: "x" })).rejects.toThrow(
			/whole file/,
		);
	});
});
