import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

describe("handleRpcSteerSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let received: IrcMessage[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		received = [];
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile: `/tmp/${id}.jsonl`,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register a live agent whose session records hub deliveries. */
	function registerLiveAgent(id: string): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				deliverIrcMessage: async (msg: IrcMessage) => {
					received.push(msg);
					return "injected";
				},
			} as never,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "running",
		});
	}

	test("delivers a steering DM attributed to the session owner to a running subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");

		const result = await handleRpcSteerSubagent(registry, "SubagentA", "Refocus on the direct path");

		expect(result).toEqual({ kind: "delivered", to: "SubagentA", outcome: "injected" });
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ from: MAIN_AGENT_ID, to: "SubagentA", body: "Refocus on the direct path" });
	});

	test("rejects an id the session never reported, even when the hub knows it", async () => {
		// A live hub peer that is not one of this session's subagents must not be reachable.
		registerLiveAgent("Stranger");

		await expect(handleRpcSteerSubagent(registry, "Stranger", "hi")).resolves.toEqual({
			kind: "error",
			message: "Subagent not running: Stranger",
		});
		expect(received).toHaveLength(0);
	});

	test("rejects a completed subagent without reviving it", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toEqual({
			kind: "error",
			message: "Subagent not running: SubagentA",
		});
		expect(received).toHaveLength(0);
	});

	test("reports a failed hub delivery as an error", async () => {
		// Lifecycle says running, but the hub has no ref (session already released).
		emitLifecycle("Ghost", "started");

		const result = await handleRpcSteerSubagent(registry, "Ghost", "hello");

		expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Delivery failed") });
	});
});
