import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const STATIC_IMPORT_FIXTURE = fileURLToPath(new URL("./fixtures/oauth-barrel-import.ts", import.meta.url));

describe("OAuth barrel imports", () => {
	it("loads with the Anthropic provider and auth storage while preserving public exports", async () => {
		const child = Bun.spawn([process.execPath, STATIC_IMPORT_FIXTURE], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode, stderr).toBe(0);
	});
});
