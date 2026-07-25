import { describe, expect, it } from "bun:test";

const CONCURRENT_IMPORT_SCRIPT = `
await Promise.all([
	import("@oh-my-pi/pi-ai/registry/oauth"),
	import("@oh-my-pi/pi-ai/providers/anthropic"),
	import("@oh-my-pi/pi-ai/auth-storage"),
]);
`;

describe("OAuth barrel imports", () => {
	it("loads concurrently with the Anthropic provider and auth storage", async () => {
		const child = Bun.spawn([process.execPath, "-e", CONCURRENT_IMPORT_SCRIPT], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode, stderr).toBe(0);
	});
});
