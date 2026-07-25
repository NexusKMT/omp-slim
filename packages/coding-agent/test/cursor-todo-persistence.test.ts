import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import {
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { SessionEntry } from "../src/session/session-entries";

interface Harness {
	handlers: CursorExecHandlers;
	entries: SessionEntry[];
	events: AgentEvent[];
	current: () => TodoPhase[];
	reload: () => TodoPhase[];
	/** Replays `event-controller.ts`'s todo refresh over the emitted events. */
	uiTodos: () => TodoPhase[] | null;
}

function newHarness(initial: TodoPhase[] = []): Harness {
	const entries: SessionEntry[] = [];
	const events: AgentEvent[] = [];
	let phases = initial;
	const handlers = new CursorExecHandlers({
		cwd: "/tmp",
		tools: new Map(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
		persistTodoPhases: next => {
			entries.push({
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: next },
			} as SessionEntry);
		},
		emitEvent: event => {
			events.push(event);
		},
	});
	return {
		handlers,
		entries,
		events,
		current: () => phases,
		// Mirrors `AgentSession.#syncTodoPhasesFromBranch`, the reload path.
		reload: () => getLatestTodoPhasesFromEntries(entries),
		uiTodos: () => {
			let todos: TodoPhase[] | null = null;
			for (const event of events) {
				if (event.type !== "tool_execution_end" || event.toolName !== "todo" || event.isError) continue;
				const details = event.result.details as { phases?: TodoPhase[] } | undefined;
				if (details?.phases) todos = details.phases;
			}
			return todos;
		},
	};
}

describe("cursor todo persistence", () => {
	it("survives a reload, which replays session entries rather than memory", () => {
		// Cursor resolves `update_todos` server-side and emits no local `todo`
		// toolResult, so nothing would otherwise land in the branch and every
		// reload/rewind/compaction would silently drop the list.
		const h = newHarness();
		h.handlers.todoSync({
			merged: false,
			todos: [
				{ content: "step one", status: "completed" },
				{ content: "step two", status: "in_progress" },
			],
		});

		expect(h.reload()).toEqual(h.current());
		expect(h.reload()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("replays the newest snapshot after repeated updates", () => {
		const h = newHarness();
		h.handlers.todoSync({ merged: false, todos: [{ content: "step one", status: "in_progress" }] });
		h.handlers.todoSync({
			merged: false,
			todos: [
				{ content: "step one", status: "completed" },
				{ content: "step two", status: "in_progress" },
			],
		});

		expect(h.reload()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("keeps existing phase grouping for tasks the session already knows", () => {
		const h = newHarness([
			{ name: "Foundation", tasks: [{ content: "scaffold", status: "pending" }] },
			{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] },
		]);
		h.handlers.todoSync({
			merged: false,
			todos: [
				{ content: "scaffold", status: "completed" },
				{ content: "oauth", status: "in_progress" },
				{ content: "unknown", status: "pending" },
			],
		});

		expect(h.reload()).toEqual([
			{ name: "Foundation", tasks: [{ content: "scaffold", status: "completed" }] },
			{ name: "Auth", tasks: [{ content: "oauth", status: "in_progress" }] },
			{ name: "Tasks", tasks: [{ content: "unknown", status: "pending" }] },
		]);
	});

	it("never invents an active task for an all-pending remote snapshot", () => {
		const h = newHarness();
		h.handlers.todoSync({
			merged: false,
			todos: [
				{ content: "a", status: "pending" },
				{ content: "b", status: "pending" },
			],
		});

		expect(h.reload()[0].tasks.every(task => task.status === "pending")).toBe(true);
	});

	it("writes nothing when the session exposes no todo state", () => {
		const entries: SessionEntry[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map(),
			persistTodoPhases: next => {
				entries.push({
					type: "custom",
					customType: USER_TODO_EDIT_CUSTOM_TYPE,
					data: { phases: next },
				} as SessionEntry);
			},
		});

		handlers.todoSync({ merged: false, todos: [{ content: "a", status: "pending" }] });

		expect(entries).toEqual([]);
	});

	it("refreshes the interactive todo panel, which only reacts to tool_execution_end", () => {
		// Cursor's todo call is resolved server-side and runs no local tool, so
		// without a synthesized event the visible panel stays stale until reload.
		const h = newHarness();
		h.handlers.todoSync({
			merged: false,
			todos: [
				{ content: "step one", status: "completed" },
				{ content: "step two", status: "in_progress" },
			],
		});

		expect(h.uiTodos()).toEqual(h.current());
		expect(h.uiTodos()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("keeps the panel, session state, and branch replay in agreement", () => {
		const h = newHarness([{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] }]);
		h.handlers.todoSync({ merged: false, todos: [{ content: "oauth", status: "completed" }] });

		expect(h.uiTodos()).toEqual(h.current());
		expect(h.reload()).toEqual(h.current());
	});

	it("emits no todo event when the session exposes no todo state", () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map(),
			emitEvent: event => {
				events.push(event);
			},
		});

		handlers.todoSync({ merged: false, todos: [{ content: "a", status: "pending" }] });

		expect(events).toEqual([]);
	});
});
