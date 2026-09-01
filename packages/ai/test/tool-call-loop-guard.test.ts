import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "../src/types";
import { ToolCallLoopGuard } from "../src/utils/tool-call-loop-guard";

let nextId = 0;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `tc_${nextId++}`, name, arguments: args };
}

function turn(...calls: ToolCall[]): { message: AssistantMessage; toolResults: [] } {
	return {
		message: { role: "assistant", content: calls, stopReason: "toolUse" } as unknown as AssistantMessage,
		toolResults: [],
	};
}

function batchA(): ToolCall[] {
	return [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
}

function batchB(): ToolCall[] {
	return [toolCall("bash", { command: "echo b" })];
}

describe("ToolCallLoopGuard", () => {
	it("resets on a turn with no tool calls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		expect(guard.recordTurn(turn())).toBeNull();
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
	});

	it("detects consecutive identical multi-call turns at the threshold", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		const hit = guard.recordTurn(turn(...batchA()));
		expect(hit).not.toBeNull();
		expect(hit!.kind).toBe("repeated_tool_call");
		expect(hit!.count).toBe(3);
	});

	it("does not count a turn whose calls are all exempt", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		expect(guard.recordTurn(turn(toolCall("read", { path: "a.ts" })))).toBeNull();
		const hit = guard.recordTurn(turn(toolCall("read", { path: "a.ts" })));
		expect(hit).toBeNull();
	});

	it("resets when every call in a multi-call turn is exempt", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		expect(guard.recordTurn(turn(toolCall("read", { path: "x.ts" }), toolCall("read", { path: "y.ts" })))).toBeNull();
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
	});

	it("counts a mixed batch and reports the first non-exempt call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		const mixed = () => [toolCall("read", { path: "a.ts" }), toolCall("bash", { command: "echo a" })];
		expect(guard.recordTurn(turn(...mixed()))).toBeNull();
		const hit = guard.recordTurn(turn(...mixed()));
		expect(hit).not.toBeNull();
		expect(hit!.toolName).toBe("bash");
	});

	it("does not count alternating distinct batches", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		expect(guard.recordTurn(turn(...batchB()))).toBeNull();
		expect(guard.recordTurn(turn(...batchA()))).toBeNull();
		expect(guard.recordTurn(turn(...batchB()))).toBeNull();
	});

	it("keeps single-call behavior: identical single calls are detected", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn(toolCall("bash", { command: "echo a" })))).toBeNull();
		const hit = guard.recordTurn(turn(toolCall("bash", { command: "echo a" })));
		expect(hit).not.toBeNull();
		expect(hit!.toolName).toBe("bash");
	});

	it("keeps single-call behavior: differing args reset the counter", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn(toolCall("bash", { command: "echo a" })))).toBeNull();
		expect(guard.recordTurn(turn(toolCall("bash", { command: "echo b" })))).toBeNull();
	});

	it("canonicalizes argument key order across a multi-call batch", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const a = () => turn(toolCall("write", { path: "x.ts", content: "hi" }));
		const reordered = () => turn(toolCall("write", { content: "hi", path: "x.ts" }));
		expect(guard.recordTurn(a())).toBeNull();
		const hit = guard.recordTurn(reordered());
		expect(hit).not.toBeNull();
	});
});
