import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanups: (() => Promise<void>)[] = [];
let runs = 0;

async function fixture() {
	const id = `InheritedModel${++runs}`;
	const current = createMockModel({ id: `current-${runs}`, handler: () => ({ content: ["Inherited answer."] }) });
	const other = createMockModel({ id: `other-${runs}`, handler: () => ({ content: ["Wrong model."] }) });
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inherited-model-"));
	const authStorage = await AuthStorage.create(":memory:");
	registerMockApi(id);
	cleanups.push(async () => {
		await AgentRegistry.global().get(id)?.session?.dispose();
		AgentRegistry.global().unregister(id);
		unregisterCustomApis(id);
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	authStorage.keys.setRuntime("mock", "test-key");
	const settings = Settings.isolated({ "task.maxRecursionDepth": 2, "compaction.enabled": false });
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"), { settings });
	// The catalog intentionally points elsewhere. The inherited model is authoritative.
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([other]);
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([other]);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			parseAgent(
				"legacy-worker.md",
				`---
name: worker
description: Read-only worker
tools: [read]
model: mock/${other.id}
prewalk: mock/${other.id}
---
Keep the worker persona.`,
				"bundled",
			),
		],
		projectAgentsDir: null,
	});
	const session = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getActiveModel: () => current,
		getActiveModelString: () => `mock/${current.id}`,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
	} as unknown as ToolSession;
	const request: StructuredSubagentRequest = {
		session,
		invocationKind: "eval",
		assignment: "Answer the question.",
		agent: "worker",
		structured: false,
		identity: { id, label: "worker" },
		keepAlive: false,
	};
	return { current, other, request };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("subagents inherit one current model", () => {
	it("runs the parent model even when the catalog, agent frontmatter and prewalk name another model", async () => {
		const { current, other, request } = await fixture();
		const create = sdk.createAgentSession;
		let options: sdk.CreateAgentSessionOptions | undefined;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(input => {
			options = input;
			return create(input);
		});
		const { result } = await runStructuredSubagent(request);
		expect(result.error).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Inherited answer.");
		expect(current.calls).toHaveLength(1);
		expect(other.calls).toHaveLength(0);
		expect(options?.model).toBe(current);
		expect(options).not.toHaveProperty("prewalk");
		expect(options?.disableModelFallback).toBe(true);
		expect(options?.disableServerSideFallback).toBe(true);
		expect(options?.toolNames).toEqual(["read"]);
		expect(() => options?.assertDispatchModel?.(other)).toThrow("inherited parent model");
	});

	it.each(["model", "perCallModel", "seanceModel"] as const)(
		"rejects a new %s override before spawning",
		async key => {
			const { current, other, request } = await fixture();
			await expect(runStructuredSubagent({ ...request, [key]: `mock/${other.id}` })).rejects.toThrow(
				"model overrides are not supported",
			);
			expect(current.calls).toHaveLength(0);
			expect(other.calls).toHaveLength(0);
		},
	);

	it("keeps extension blocking but refuses an extension model replacement", async () => {
		const { current, other, request } = await fixture();
		request.session.emitBeforeSubagentSpawn = async () => ({ model: `mock/${other.id}` });
		await expect(runStructuredSubagent(request)).rejects.toThrow("Extensions cannot replace a subagent model");
		expect(current.calls).toHaveLength(0);
		expect(other.calls).toHaveLength(0);
	});
});
