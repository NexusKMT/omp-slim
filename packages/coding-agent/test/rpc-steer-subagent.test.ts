import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

interface PromptCall {
	id: string;
	text: string;
	streamingBehavior: unknown;
}

describe("handleRpcSteerSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let prompts: PromptCall[];
	let sessionDir: string;
	let ownSessionFile: string;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		prompts = [];
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-steer-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile: ownSessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register a live subagent whose session records prompts; `prompt` never settles, like a real turn. */
	function registerLiveAgent(id: string, sessionFile = ownSessionFile): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				prompt: (text: string, options: { streamingBehavior?: unknown }) => {
					prompts.push({ id, text, streamingBehavior: options.streamingBehavior });
					return Promise.withResolvers<void>().promise;
				},
			} as never,
			sessionFile,
			status: "running",
		});
	}

	test("prompts the subagent's own session as a steer, verbatim, without waiting for its turn", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		const message = "  fn main() {\n      todo!()\n  }\n";

		// Resolves even though the subagent's prompt never settles.
		await expect(handleRpcSteerSubagent(registry, "SubagentA", message)).resolves.toBeUndefined();

		expect(prompts).toEqual([{ id: "SubagentA", text: message, streamingBehavior: "steer" }]);
	});

	test("does not reach another session's same-name subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hi")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(prompts).toEqual([]);
	});

	test("does not reach a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcSteerSubagent(registry, "Stranger", "hi")).resolves.toBe("Subagent not running: Stranger");
		expect(prompts).toEqual([]);
	});

	test("does not reach a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(prompts).toEqual([]);
	});

	test("reports a subagent the lifecycle cannot bring back", async () => {
		emitLifecycle("SubagentA", "started");
		// Parked (no live session) and no reviver registered.
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: null,
			sessionFile: ownSessionFile,
			status: "parked",
		});

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toStartWith(
			"Subagent not reachable:",
		);
	});
});
