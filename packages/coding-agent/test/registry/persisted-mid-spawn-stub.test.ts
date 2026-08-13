import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

async function registerFrom(dir: string): Promise<AgentRegistry> {
	const registry = new AgentRegistry();
	await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
	return registry;
}

describe("registerPersistedSubagents mid-spawn stubs", () => {
	it("does not park a child that only has the SessionManager header", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-stub-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Adversary.jsonl"),
			`${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-13T17:14:48.125Z", pad: " " })}\n${sessionHeader("adversary")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Adversary")).toBeUndefined();
	});

	it("still parks a finished child that recorded session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-init-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Worker.jsonl"),
			[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
					agent: "adversarial-reviewer",
				}),
			].join("\n") + "\n",
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Worker")?.status).toBe("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(path.join(dir, "main", "Worker.jsonl"));
	});

	it("still parks a legacy child that has messages but no session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-legacy-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Legacy.jsonl"),
			[
				sessionHeader("legacy"),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n") + "\n",
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Legacy")?.status).toBe("parked");
	});
});
