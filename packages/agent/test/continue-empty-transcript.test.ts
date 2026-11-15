import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";

/**
 * Regression: a `steer` (or follow-up) queued on an empty transcript must be
 * delivered as the opening turn instead of leaving `continue()` to throw
 * `No messages to continue from`. Before the fix the steer stayed queued, so the
 * RPC idle-drain re-armed `continue()` on every microtask (gated only on
 * `hasQueuedMessages()`), an unbounded allocation loop that OOM-killed the
 * process (issue #6344).
 */
describe("Agent.continue() on an empty transcript", () => {
	it("still throws when the transcript is empty and nothing is queued", async () => {
		const agent = new Agent();
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
	});
});
