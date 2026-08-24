/**
 * `!command` config values must not leak inherited file descriptors into the
 * credential-resolving child.
 *
 * A launcher can legitimately hand omp an open descriptor (for example a
 * credential bundle) that is meant to stay single-consumer. The child spawned
 * for `auth.broker.url` / header `!command` resolution used to run through the
 * natives brush shell (executeShell), whose children inherit every inheritable
 * descriptor; the models.yml apiKey resolver (execSync) already spawned with
 * stdio pipes only. The fix converges the config-value path on the same
 * child_process primitive.
 *
 * Discriminating oracle: an external helper script whose body is `cat <&3`
 * — it succeeds only when fd 3 survived into the resolution child. Red
 * before the fix (the canary content resolves as the value), green after (the
 * helper's dup fails, the command exits non-zero, resolveConfigValue returns
 * undefined). No /proc dependency, so the oracle discriminates on every
 * non-Windows platform. (brush itself rejects `<&3` in the command string
 * while still passing inherited fds through to external children, so the
 * oracle must be a script, not an inline redirection.)
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const resolverUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/resolve-config-value.ts")).href;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"config !command children cannot read descriptors the launcher passed omp",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-fd-"));
		roots.push(root);
		const canaryPath = path.join(root, "canary.txt");
		fs.writeFileSync(canaryPath, "CANARY-THAT-MUST-NOT-RESOLVE");
		const spyPath = path.join(root, "fd3-spy.sh");
		fs.writeFileSync(spyPath, "#!/usr/bin/env bash\ncat <&3\n", { mode: 0o755 });

		// The child receives fd 3 the way a launcher would pass one: an extra
		// stdio entry, dup2'd in regardless of close-on-exec state.
		const canaryFd = fs.openSync(canaryPath, "r");
		try {
			// The resolver must load in a child process: fd inheritance only exists
			// across a real exec boundary, so the probe runs via --eval in a spawned
			// bun (same pattern as cli-provider-api-keys.test.ts).
			const script = `import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};
const value = await resolveConfigValue("!${spyPath}");
console.log(value === undefined ? "RESOLVED-UNDEFINED" : "LEAKED:" + value);`;
			const proc = Bun.spawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", canaryFd],
				timeout: 15_000,
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode, stdout).toBe(0);
			expect(stdout.trim()).toBe("RESOLVED-UNDEFINED");
		} finally {
			fs.closeSync(canaryFd);
		}
	},
);
