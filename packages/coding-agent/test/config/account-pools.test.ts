import { describe, expect, it } from "bun:test";
import { validateAgentAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("task.agentAccountPools", () => {
	it("keeps an empty provider list as a deny-all pool and lets null clear an agent", () => {
		expect(validateAgentAccountPools(undefined)).toEqual({});
		expect(validateAgentAccountPools(null)).toEqual({});
		expect(
			validateAgentAccountPools({
				reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] },
				cleared: null,
			}),
		).toEqual({ reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] } });
	});

	it("rejects every malformed level instead of widening the agent to all accounts", () => {
		const malformed: [unknown, string][] = [
			["reviewer", "Invalid task.agentAccountPools:"],
			[[], "Invalid task.agentAccountPools:"],
			[{ reviewer: ["email:a@example.com"] }, "Invalid task.agentAccountPools.reviewer:"],
			[{ reviewer: { anthropic: "email:a@example.com" } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: null } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [""] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [" email:a@example.com"] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [42] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentAccountPools(value)).toThrow(message);
		}
	});

	it("fails settings load on a malformed pool", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: "email:a@example.com" } } },
			}),
		).rejects.toThrow("Invalid task.agentAccountPools.reviewer.anthropic:");
	});
});
