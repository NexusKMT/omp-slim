import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager, SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

/** Resume `sessionFile` in another omp-like process and keep it open until stdin closes. */
async function resumeInOtherProcess(
	tempDir: TempDir,
	sessionFile: string,
): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
	const script = tempDir.join("resume-and-hold.ts");
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			'process.stdout.write("ready\\n");',
			"await Bun.stdin.text();",
			"await manager.close();",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, sessionFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	let output = "";
	while (!output.includes("ready\n")) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`Resuming process exited early: ${await new Response(child.stderr).text()}`);
		output += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return child;
}

async function noticesFromResuming(sessionFile: string, sessionDir: string): Promise<Error[]> {
	const manager = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	const notices: Error[] = [];
	manager.onPersistenceError(error => notices.push(error));
	await manager.close();
	return notices;
}

describe("SessionManager resume of a session open in another process", () => {
	it("warns while another live process holds the session and not after that process died", async () => {
		using tempDir = TempDir.createSync("@omp-shared-session-file-");
		const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		await creator.ensureOnDisk();
		const sessionFile = creator.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await creator.close();

		const other = await resumeInOtherProcess(tempDir, sessionFile);
		try {
			const notices = await noticesFromResuming(sessionFile, tempDir.path());
			expect(notices).toHaveLength(1);
			expect(notices[0]).toBeInstanceOf(SessionPersistenceNotice);
			expect(notices[0]?.message).toContain(sessionFile);
			expect(notices[0]?.message).toContain("another omp process");
		} finally {
			// A crash, not a clean close: the dead owner never releases its claim itself.
			other.kill("SIGKILL");
			await other.exited;
		}

		expect(await noticesFromResuming(sessionFile, tempDir.path())).toEqual([]);
	}, 30_000);
});
