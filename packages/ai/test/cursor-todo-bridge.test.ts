import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type BlockState,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, CursorTodoSnapshot } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	ReadTodosArgsSchema,
	ReadTodosResultSchema,
	ReadTodosSuccessSchema,
	ReadTodosToolCallSchema,
	type TodoItem,
	TodoItemSchema,
	type ToolCall,
	ToolCallCompletedUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	UpdateTodosArgsSchema,
	UpdateTodosErrorSchema,
	UpdateTodosResultSchema,
	UpdateTodosSuccessSchema,
	UpdateTodosToolCallSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

interface Harness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	state: BlockState;
	usageState: UsageState;
	snapshots: CursorTodoSnapshot[];
}

function newHarness(): Harness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const stream = new AssistantMessageEventStream();
	const snapshots: CursorTodoSnapshot[] = [];
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		onTodoSnapshot: snapshot => {
			snapshots.push(snapshot);
		},
	};
	return { output, stream, state, usageState: { sawTokenDelta: false }, snapshots };
}

function start(h: Harness, toolCall: unknown, callId = "call-1"): void {
	processInteractionUpdate(
		{ message: { case: "toolCallStarted", value: { callId, toolCall } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function complete(h: Harness, toolCall: unknown): void {
	processInteractionUpdate(
		{ message: { case: "toolCallCompleted", value: { toolCall } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function todoBlocks(h: Harness): ToolCallState[] {
	return h.output.content.filter((c): c is ToolCallState => c.type === "toolCall" && c.name === "todo");
}

describe("cursor native todo bridge", () => {
	it("never marks a native todo block runnable by the shared tool loop", () => {
		// `ExecServerMessage` has no todo case: Cursor settles these server-side.
		// An unresolved block would make `agent-loop` execute a tool that has no
		// local counterpart and drive a spurious continuation turn.
		const h = newHarness();
		start(h, { updateTodosToolCall: { args: { todos: [{ content: "a", status: 1 }] } } });
		start(h, { readTodosToolCall: { args: {} } }, "call-2");

		const blocks = todoBlocks(h);
		expect(blocks).toHaveLength(2);
		for (const block of blocks) {
			expect(block[kCursorExecResolved]).toBe(true);
		}
	});

	it("takes the server success snapshot as truth over the requested args", () => {
		const h = newHarness();
		const args = { merge: true, todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		complete(h, {
			updateTodosToolCall: {
				args,
				result: {
					result: {
						case: "success",
						value: {
							wasMerge: true,
							todos: [
								{ content: "pre-existing", status: 3 },
								{ content: "requested", status: 2 },
							],
						},
					},
				},
			},
		});

		expect(h.snapshots).toEqual([
			{
				todos: [
					{ content: "pre-existing", status: "completed" },
					{ content: "requested", status: "in_progress" },
				],
				merged: true,
			},
		]);
		expect(todoBlocks(h)[0].arguments).toEqual({
			todos: [
				{ content: "pre-existing", status: "completed" },
				{ content: "requested", status: "in_progress" },
			],
			merged: true,
		});
	});

	it("maps TODO_STATUS_CANCELLED to abandoned instead of resurrecting the task", () => {
		const h = newHarness();
		start(h, { updateTodosToolCall: { args: { todos: [] } } });
		complete(h, {
			updateTodosToolCall: {
				args: { todos: [] },
				result: { result: { case: "success", value: { todos: [{ content: "dropped", status: 4 }] } } },
			},
		});

		expect(h.snapshots[0].todos).toEqual([{ content: "dropped", status: "abandoned" }]);
	});

	it("leaves local state untouched when the server reports an error", () => {
		const h = newHarness();
		const args = { todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		const before = todoBlocks(h)[0].arguments;
		complete(h, {
			updateTodosToolCall: { args, result: { result: { case: "error", value: { error: "quota exceeded" } } } },
		});

		expect(h.snapshots).toEqual([]);
		expect(todoBlocks(h)[0].arguments).toEqual(before);
	});

	it("leaves local state untouched when the completion carries no result", () => {
		const h = newHarness();
		const args = { todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		complete(h, { updateTodosToolCall: { args } });

		expect(h.snapshots).toEqual([]);
	});

	it("refreshes local state from a read_todos snapshot", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: { result: { case: "success", value: { todos: [{ content: "remote", status: 2 }] } } },
			},
		});

		expect(h.snapshots).toEqual([{ todos: [{ content: "remote", status: "in_progress" }], merged: false }]);
	});

	it("refuses a status-filtered read_todos result, which is a subset and not the list", () => {
		// `ReadTodosArgs.status_filter` narrows the response; mirroring it would
		// delete every task the filter excluded.
		const h = newHarness();
		const args = { statusFilter: [2] };
		start(h, { readTodosToolCall: { args } });
		complete(h, {
			readTodosToolCall: {
				args,
				result: { result: { case: "success", value: { todos: [{ content: "only in progress", status: 2 }] } } },
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("refuses an id-filtered read_todos result", () => {
		const h = newHarness();
		const args = { idFilter: ["task-1"] };
		start(h, { readTodosToolCall: { args } });
		complete(h, {
			readTodosToolCall: {
				args,
				result: { result: { case: "success", value: { todos: [{ content: "one task", status: 1 }] } } },
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("refuses a read_todos result truncated below the server's own total_count", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: {
						case: "success",
						value: { todos: [{ content: "first of three", status: 2 }], totalCount: 3 },
					},
				},
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("accepts a read_todos result whose row count matches total_count", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: {
						case: "success",
						value: {
							todos: [
								{ content: "one", status: 3 },
								{ content: "two", status: 2 },
							],
							totalCount: 2,
						},
					},
				},
			},
		});

		expect(h.snapshots[0].todos).toEqual([
			{ content: "one", status: "completed" },
			{ content: "two", status: "in_progress" },
		]);
	});
});

/**
 * The fixtures above hand-shape `toolCall` with a flattened
 * `updateTodosToolCall` property. A decoded `agent.v1.ToolCall` does NOT look
 * like that: `tool` is a protobuf oneof, so the variant only ever arrives as
 * `tool: { case, value }`. These tests drive the bridge with messages that
 * round-trip through the actual wire encoding, which is the only shape
 * production ever sees.
 */
describe("cursor native todo bridge (wire-encoded protobuf)", () => {
	function wireUpdate(kind: "toolCallStarted" | "toolCallCompleted", toolCall: ToolCall): unknown {
		const value =
			kind === "toolCallStarted"
				? create(ToolCallStartedUpdateSchema, { callId: "call-1", toolCall })
				: create(ToolCallCompletedUpdateSchema, { callId: "call-1", toolCall });
		const server = create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, { message: { case: kind, value } } as never),
			},
		});
		// handleServerMessage forwards `message.value` to processInteractionUpdate.
		return fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, server)).message.value;
	}

	function items(rows: [string, string, number][]) {
		return rows.map(([id, content, status]) => create(TodoItemSchema, { id, content, status }));
	}

	function successResult(todos: TodoItem[], totalCount: number, wasMerge = false) {
		return create(UpdateTodosResultSchema, {
			result: {
				case: "success",
				value: create(UpdateTodosSuccessSchema, { todos, totalCount, wasMerge }),
			},
		});
	}

	// `read_todos` settles on its own result message: no `was_merge`, and a
	// `total_count` that reports the full size even when rows are withheld.
	function readSuccessResult(todos: TodoItem[], totalCount: number) {
		return create(ReadTodosResultSchema, {
			result: { case: "success", value: create(ReadTodosSuccessSchema, { todos, totalCount }) },
		});
	}

	function updateCall(todos: TodoItem[], totalCount: number, wasMerge = false): ToolCall {
		return create(ToolCallSchema, {
			tool: {
				case: "updateTodosToolCall",
				value: create(UpdateTodosToolCallSchema, {
					args: create(UpdateTodosArgsSchema, { todos: [], merge: wasMerge }),
					result: successResult(todos, totalCount, wasMerge),
				}),
			},
		});
	}

	function readCall(
		todos: TodoItem[],
		totalCount: number,
		args: { statusFilter?: number[]; idFilter?: string[] } = {},
	): ToolCall {
		return create(ToolCallSchema, {
			tool: {
				case: "readTodosToolCall",
				value: create(ReadTodosToolCallSchema, {
					args: create(ReadTodosArgsSchema, args),
					result: readSuccessResult(todos, totalCount),
				}),
			},
		});
	}

	function drive(toolCall: ToolCall): Harness {
		const h = newHarness();
		processInteractionUpdate(
			wireUpdate("toolCallStarted", toolCall) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		processInteractionUpdate(
			wireUpdate("toolCallCompleted", toolCall) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		return h;
	}

	it("synthesizes a todo block from a wire-decoded update_todos oneof", () => {
		const h = drive(updateCall(items([["1", "done task", 3]]), 1));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(todoBlocks(h)[0][kCursorExecResolved]).toBe(true);
	});

	it("mirrors the server snapshot from a wire-decoded update_todos oneof", () => {
		const h = drive(
			updateCall(
				items([
					["1", "done task", 3],
					["2", "active task", 2],
				]),
				2,
				true,
			),
		);

		expect(h.snapshots).toEqual([
			{
				todos: [
					{ content: "done task", status: "completed" },
					{ content: "active task", status: "in_progress" },
				],
				merged: true,
			},
		]);
	});

	it("mirrors a complete wire-decoded read_todos oneof", () => {
		const h = drive(readCall(items([["1", "only task", 2]]), 1));

		expect(h.snapshots).toEqual([{ todos: [{ content: "only task", status: "in_progress" }], merged: false }]);
	});

	it("refuses a wire-decoded read_todos truncated below total_count", () => {
		const h = drive(readCall(items([["1", "only task", 2]]), 5));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("refuses a wire-decoded read_todos narrowed by status_filter", () => {
		const rows: [string, string, number][] = [["1", "only task", 3]];
		// Positive control: the identical response without the filter does sync,
		// so the refusal below is attributable to the filter and not to the
		// bridge failing to decode the oneof at all.
		expect(drive(readCall(items(rows), 1)).snapshots).toHaveLength(1);

		const h = drive(readCall(items(rows), 1, { statusFilter: [3] }));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("leaves local state untouched when the wire result carries an error", () => {
		const toolCall = create(ToolCallSchema, {
			tool: {
				case: "updateTodosToolCall",
				value: create(UpdateTodosToolCallSchema, {
					args: create(UpdateTodosArgsSchema, { todos: [], merge: false }),
					result: create(UpdateTodosResultSchema, {
						result: { case: "error", value: create(UpdateTodosErrorSchema, { error: "boom" }) },
					}),
				}),
			},
		});

		const h = drive(toolCall);

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});
});
