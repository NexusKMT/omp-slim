import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRpcCancelSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

describe("handleRpcCancelSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let calls: string[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		calls = [];
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register a live subagent whose session records abort/dispose calls. */
	function registerLiveAgent(id: string): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				abort: async () => {
					calls.push(`abort:${id}`);
				},
				dispose: async () => {
					calls.push(`dispose:${id}`);
				},
			} as never,
			status: "running",
		});
	}

	test("aborts a running subagent and leaves an aborted tombstone", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(true);

		expect(calls).toEqual(["abort:SubagentA", "dispose:SubagentA"]);
		const ref = AgentRegistry.global().get("SubagentA");
		expect(ref?.status).toBe("aborted");
		expect(ref?.session).toBeNull();
	});

	test("is a no-op for a second cancel of the same subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		await handleRpcCancelSubagent(registry, "SubagentA");
		calls = [];

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	test("does not tombstone a subagent whose result was accepted before its terminal frame", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		// Yield acceptance flips the ref to idle while the roster still lists it.
		AgentRegistry.global().markResultAccepted("SubagentA");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("SubagentA")?.status).toBe("idle");
	});

	test("does not touch a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcCancelSubagent(registry, "Stranger")).resolves.toBe(false);

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("Stranger")?.status).toBe("running");
	});

	test("does not touch a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcCancelSubagent(registry, "SubagentA")).resolves.toBe(false);
		expect(calls).toEqual([]);
	});
});
