/** Vibe workers retain their persona and inherit the current parent model. */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as nameGenerator from "@oh-my-pi/pi-coding-agent/task/name-generator";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

const activeModel = createMockModel({ id: "active-parent" });

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		getActiveModel: () => activeModel,
		getActiveModelString: () => "mock/active-parent",
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(cli: VibeCli, settings: Settings, name?: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings), { cli, name, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn options", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("inherits the active model for the good worker", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
			}),
		);

		expect(options.parentModel).toBe(activeModel);
		expect(options.modelRole).toBeUndefined();
	});

	it("inherits the same active model for the fast worker", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.parentModel).toBe(activeModel);
		expect(options.modelRole).toBeUndefined();
	});

	it("ignores a retired per-agent model override", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.parentModel).toBe(activeModel);
		expect(options.modelRole).toBeUndefined();
	});

	it("restricts the first spawn to the worker agent's account pool, as revival does", async () => {
		// Without it a worker runs unrestricted until it is parked and revived.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentAccountPools": {
					task: { anthropic: ["email:a@example.com|org:org-a"] },
					sonic: { anthropic: [] },
				},
			}),
		);

		expect(options.oauthAccountPools).toEqual({ anthropic: ["email:a@example.com|org:org-a"] });
	});

	it("keeps only [A-Za-z0-9_-] from a custom worker name", async () => {
		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "../My Worker!");

		expect(options.id).toBe("MyWorker");
	});

	it("falls back to a generated name when nothing in the custom name survives", async () => {
		vi.spyOn(nameGenerator, "generateTaskName").mockReturnValue("GeneratedWorker");

		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "!!!");

		expect(options.id).toBe("GeneratedWorker");
	});
});
