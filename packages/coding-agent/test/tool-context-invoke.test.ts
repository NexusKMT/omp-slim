/**
 * Tests for `ctx.invokeTool` — a tool delegating to another tool's native built-in implementation
 * via the ToolContextStore-built AgentToolContext.
 */

import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { ToolContextStore } from "@oh-my-pi/pi-coding-agent/tools/context";

const baseContext = () => ({}) as never;

function makeTool(name: string, exec: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: exec,
	} as AgentTool;
}

describe("ctx.invokeTool native-tool delegation", () => {
	it("is absent when the store has no native-tool resolver", () => {
		const store = new ToolContextStore(baseContext);
		expect(store.getContext().invokeTool).toBeUndefined();
	});

	it("runs the native tool and returns its result", async () => {
		const seen: unknown[] = [];
		const native = makeTool("write", async (_id, params) => {
			seen.push(params);
			return { content: [{ type: "text", text: "native wrote" }], details: { ok: true } } as AgentToolResult;
		});
		const store = new ToolContextStore(baseContext, name => (name === "write" ? native : undefined));

		const result = await store.getContext().invokeTool?.("write", { path: "/tmp/x", content: "hi" });

		expect(seen).toEqual([{ path: "/tmp/x", content: "hi" }]);
		expect(result?.content).toEqual([{ type: "text", text: "native wrote" }]);
		expect(result?.details).toEqual({ ok: true });
	});

	it("resolves to undefined for an unknown tool name", async () => {
		const store = new ToolContextStore(baseContext, () => undefined);
		expect(await store.getContext().invokeTool?.("nope", {})).toBeUndefined();
	});

	it("forwards signal and onUpdate to the native tool", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		let receivedOnUpdate: unknown;
		const native = makeTool("read", async (_id, _params, signal, onUpdate) => {
			receivedSignal = signal;
			receivedOnUpdate = onUpdate;
			return { content: [{ type: "text", text: "ok" }], details: {} } as AgentToolResult;
		});
		const store = new ToolContextStore(baseContext, () => native);
		const onUpdate = () => {};

		await store.getContext().invokeTool?.("read", {}, { signal: controller.signal, onUpdate });

		expect(receivedSignal).toBe(controller.signal);
		expect(receivedOnUpdate).toBe(onUpdate);
	});

	it("passes a context whose invokeTool lets the native tool delegate further", async () => {
		const inner = makeTool(
			"inner",
			async () => ({ content: [{ type: "text", text: "inner ran" }], details: {} }) as AgentToolResult,
		);
		let innerResult: AgentToolResult | undefined;
		const outer = makeTool("outer", async (_id, _params, _signal, _onUpdate, ctx) => {
			innerResult = await ctx?.invokeTool?.("inner", {});
			return { content: [{ type: "text", text: "outer ran" }], details: {} } as AgentToolResult;
		});
		const store = new ToolContextStore(baseContext, name =>
			name === "outer" ? outer : name === "inner" ? inner : undefined,
		);

		await store.getContext().invokeTool?.("outer", {});

		expect(innerResult?.content).toEqual([{ type: "text", text: "inner ran" }]);
	});

	it("guards against runaway recursion when a tool invokes itself", async () => {
		// A pathological tool that always re-invokes its own native name. The depth guard must throw
		// rather than recurse until the stack blows.
		const loop = makeTool("loop", async (_id, _params, _signal, _onUpdate, ctx) => {
			return (await ctx?.invokeTool?.("loop", {})) as AgentToolResult;
		});
		const store = new ToolContextStore(baseContext, name => (name === "loop" ? loop : undefined));
		const invokeTool = store.getContext().invokeTool;
		if (!invokeTool) throw new Error("invokeTool should be present when a resolver is set");

		await expect(invokeTool("loop", {})).rejects.toThrow(/delegation depth exceeded/);
	});
});
