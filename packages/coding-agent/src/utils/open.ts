import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { $which, isWsl, logger } from "@oh-my-pi/pi-utils";

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function getExistingWslLocalPath(urlOrPath: string): string | undefined {
	if (!isWsl() || !$which("wslview")) {
		return undefined;
	}

	try {
		const localPath = urlOrPath.startsWith("file://")
			? url.fileURLToPath(urlOrPath)
			: URL_SCHEME_PATTERN.test(urlOrPath)
				? undefined
				: path.resolve(urlOrPath);
		if (!localPath || !fs.existsSync(localPath)) return undefined;

		const result = Bun.spawnSync(["wslpath", "-w", localPath], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return undefined;

		return result.stdout.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Open a URL or file path in the default browser/application. Best-effort, never throws. */
export function openPath(urlOrPath: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", urlOrPath];
			break;
		default: {
			const wslPath = getExistingWslLocalPath(urlOrPath);
			cmd = wslPath ? ["wslview", wslPath] : ["xdg-open", urlOrPath];
			break;
		}
	}
	let child: Bun.Subprocess | undefined;
	try {
		child = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch (error) {
		// Spawn threw synchronously (missing binary, denied exec, sandbox
		// restriction, …). Best-effort: log so the failure isn't invisible while
		// still letting the caller advertise a copy-URL fallback.
		logger.warn("Failed to open external URL/path", {
			command: cmd[0],
			target: urlOrPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	// Detect delayed failures (exec succeeded but the opener exited non-zero)
	// without blocking the caller. Recording them makes silent misconfigurations
	// (e.g. `xdg-open` present but no MIME handler for `https`) diagnosable from
	// `~/.omp/logs/omp.*.log`.
	child.exited.then(
		exitCode => {
			if (typeof exitCode === "number" && exitCode !== 0) {
				logger.warn("External opener exited with non-zero status", {
					command: cmd[0],
					target: urlOrPath,
					exitCode,
				});
			}
		},
		() => {
			// Ignore — awaiting the subprocess is best-effort telemetry.
		},
	);
}
