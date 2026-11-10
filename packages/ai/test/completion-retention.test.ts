import { describe, expect, test } from "bun:test";
import * as path from "node:path";

describe("completion event retention", () => {
	for (const completion of ["complete", "completeSimple"]) {
		for (const outcome of ["success", "failure"]) {
			test(`${completion} releases events before ${outcome} settles the response`, async () => {
				const child = Bun.spawn(
					[
						process.execPath,
						"test",
						path.join(import.meta.dir, "fixtures/completion-retention.ts"),
						"--timeout=10000",
					],
					{
						stdout: "pipe",
						stderr: "pipe",
						env: { ...process.env, OMP_COMPLETION_FIXTURE: completion, OMP_COMPLETION_OUTCOME: outcome },
					},
				);
				const timeout = setTimeout(() => child.kill(), 10_000);
				try {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect(exitCode).toBe(0);
					expect(stdout).toContain("verified\n");
					expect(stderr).toContain("0 fail");
				} finally {
					clearTimeout(timeout);
					child.kill();
					await child.exited;
				}
			}, 15_000);
		}
	}
});
