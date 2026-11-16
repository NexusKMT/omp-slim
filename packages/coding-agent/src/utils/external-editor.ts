/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Returns the user's preferred editor command.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *
 * Returns `undefined` when neither variable is set so the caller can surface a
 * warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	return $env.VISUAL?.trim() || $env.EDITOR?.trim() || undefined;
}

/**
 * Names the editor {@link getEditorCommand} launches for UI labels ("Edit in
 * nvim"): the command's program without its directory or quotes. `undefined`
 * when none is resolved.
 */
export function getEditorName(command = getEditorCommand()): string | undefined {
	if (!command) return undefined;
	const quote = command[0] === '"' || command[0] === "'" ? command[0] : undefined;
	const program = quote ? command.slice(1).split(quote)[0] : command.split(/\s+/)[0];
	const name = path.basename(program ?? "").trim();
	return name || undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/** Subprocess argv used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(editorCmd: string, tmpFile: string): EditorSpawnCommand {
	return { cmd: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile] };
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);
		const exitCode = await openEditorOnPath(editorCmd, tmpFile);
		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Opens an existing file in the user's editor, which writes it in place, and
 * returns the editor's exit code. The file may have been saved even when the
 * code is non-zero, so callers that care re-read it.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openEditorOnPath(editorCmd: string, filePath: string): Promise<number> {
	const spawnCommand = resolveEditorSpawnCommand(editorCmd, filePath);
	// Inherit the real pane pty so terminal editors (including emacsclient,
	// which resolves the device via ttyname) render into the visible pane.
	const child = Bun.spawn(spawnCommand.cmd, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}
