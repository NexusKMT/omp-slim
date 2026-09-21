import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import { rpcUnknownCommandResponse, selectRpcEntries } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-compat";
import { readRpcInputFrames } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function customEntry(id: string, parentId: string | null): SessionEntry {
	return { type: "custom", id, parentId, timestamp: new Date().toISOString(), customType: "probe" };
}

describe("RPC Pi-compatible get_entries slice", () => {
	test("no since returns all entries in append order with leafId", () => {
		const entries = [customEntry("e1", null), customEntry("e2", "e1"), customEntry("e3", "e2")];
		const result = selectRpcEntries(entries, "e3");
		expect(result.entries.map(entry => entry.id)).toEqual(["e1", "e2", "e3"]);
		expect(result.leafId).toBe("e3");
	});

	test("since returns entries strictly after the matching durable entry", () => {
		const entries = [customEntry("e1", null), customEntry("e2", "e1"), customEntry("e3", "e2")];
		const result = selectRpcEntries(entries, "e3", "e1");
		expect(result.entries.map(entry => entry.id)).toEqual(["e2", "e3"]);
		expect(result.leafId).toBe("e3");
	});

	test("since at the tail returns an empty append with the current leaf", () => {
		const entries = [customEntry("e1", null), customEntry("e2", "e1")];
		const result = selectRpcEntries(entries, "e2", "e2");
		expect(result.entries).toEqual([]);
		expect(result.leafId).toBe("e2");
	});

	test("unknown since fails explicitly", () => {
		const entries = [customEntry("e1", null)];
		expect(() => selectRpcEntries(entries, "e1", "missing")).toThrow("Unknown entries cursor: missing");
	});

	test("null leaf passes through for empty history", () => {
		const result = selectRpcEntries([], null);
		expect(result.entries).toEqual([]);
		expect(result.leafId).toBeNull();
	});
});

describe("RPC ordinary error correlation", () => {
	test("unknown command preserves the caller id", () => {
		const response = rpcUnknownCommandResponse({ type: "nope", id: "corr-1" });
		expect(response).toEqual({
			id: "corr-1",
			type: "response",
			command: "nope",
			success: false,
			error: "Unknown command: nope",
		});
	});

	test("unknown command without id stays uncorrelated", () => {
		const response = rpcUnknownCommandResponse({ type: "nope" });
		expect(response.id).toBeUndefined();
		expect(response.command).toBe("nope");
		expect(response.success).toBe(false);
	});

	test("malformed JSON remains safely uncorrelated and the reader continues", async () => {
		const input = new Blob([
			"this is not json\n",
			`${JSON.stringify({ type: "get_state", id: "after-bad-line" })}\n`,
		]).stream();
		const frames: unknown[] = [];
		const parseErrors: string[] = [];
		await readRpcInputFrames(
			input,
			frame => frames.push(frame),
			message => parseErrors.push(message),
		);
		expect(parseErrors).toHaveLength(1);
		expect(parseErrors[0]).toContain("Failed to parse command");
		expect(frames).toEqual([{ type: "get_state", id: "after-bad-line" }]);
	});
});

type RpcFrame = Record<string, unknown>;

async function withRpcServer<T>(
	run: (send: (frame: object) => void, next: () => Promise<RpcFrame>, sendRaw: (line: string) => void) => Promise<T>,
): Promise<T> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" } as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	const queue: RpcFrame[] = [];
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) queue.push(line);
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
		}
	})();
	const send = (frame: object): void => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const sendRaw = (line: string): void => {
		child.stdin.write(`${line}\n`);
	};
	const next = async (): Promise<RpcFrame> => {
		for (let waited = 0; waited < 300; waited++) {
			const readyIndex = queue.findIndex(frame => frame.type === "ready");
			if (readyIndex !== -1) {
				queue.splice(readyIndex, 1);
				continue;
			}
			const availableCommandsIndex = queue.findIndex(frame => frame.type === "available_commands_update");
			if (availableCommandsIndex !== -1) {
				queue.splice(availableCommandsIndex, 1);
				continue;
			}
			if (queue.length > 0) return queue.shift()!;
			if (readerDone) throw new Error(`RPC stream ended early: ${await stderrPromise} ${String(readerError ?? "")}`);
			await Bun.sleep(100);
		}
		throw new Error("Timed out waiting for RPC frame");
	};
	try {
		await child.stdin.flush?.();
		return await run(send, next, sendRaw);
	} finally {
		try {
			child.stdin.end();
		} catch {}
		child.kill();
		await child.exited.catch(() => {});
		await pump.catch(() => {});
		await stderrPromise.catch(() => {});
	}
}

describe("RPC Pi-compatible primitives (live server)", () => {
	test("get_entries, get_tree, thinking levels, and get_commands alias", async () => {
		await withRpcServer(async (send, next) => {
			send({ type: "get_entries", id: "entries-base" });
			const entriesBase = await next();
			expect(entriesBase.id).toBe("entries-base");
			expect(entriesBase.command).toBe("get_entries");
			expect(entriesBase.success).toBe(true);
			const baseData = entriesBase.data as { entries: unknown[]; leafId: string | null };
			expect(Array.isArray(baseData.entries)).toBe(true);
			expect(baseData.leafId === null || typeof baseData.leafId === "string").toBe(true);

			send({ type: "get_tree", id: "tree-base" });
			const tree = await next();
			expect(tree.id).toBe("tree-base");
			expect(tree.command).toBe("get_tree");
			expect(tree.success).toBe(true);
			const treeData = tree.data as { tree: unknown[]; leafId: string | null };
			expect(Array.isArray(treeData.tree)).toBe(true);
			expect(treeData.leafId).toBe(baseData.leafId);

			send({ type: "get_available_thinking_levels", id: "levels" });
			const levels = await next();
			expect(levels.id).toBe("levels");
			expect(levels.command).toBe("get_available_thinking_levels");
			expect(levels.success).toBe(true);
			expect(Array.isArray((levels.data as { levels: unknown[] }).levels)).toBe(true);

			send({ type: "get_available_commands", id: "cmds-a" });
			const available = await next();
			expect(available.success).toBe(true);
			send({ type: "get_commands", id: "cmds-b" });
			const alias = await next();
			expect(alias.id).toBe("cmds-b");
			expect(alias.command).toBe("get_commands");
			expect(alias.success).toBe(true);
			expect((alias.data as { commands: unknown[] }).commands).toEqual(
				(available.data as { commands: unknown[] }).commands,
			);
		});
	}, 60000);

	test("ordinary failures preserve ids; malformed JSON stays uncorrelated", async () => {
		await withRpcServer(async (send, next, sendRaw) => {
			send({ type: "definitely_not_a_command", id: "unknown-1" });
			const unknown = await next();
			expect(unknown.id).toBe("unknown-1");
			expect(unknown.command).toBe("definitely_not_a_command");
			expect(unknown.success).toBe(false);

			send({ type: "set_session_name", id: "bad-arg", name: "   " });
			const invalid = await next();
			expect(invalid.id).toBe("bad-arg");
			expect(invalid.command).toBe("set_session_name");
			expect(invalid.success).toBe(false);

			send({ type: "get_entries", id: "unknown-since", since: "missing-entry-id" });
			const since = await next();
			expect(since.id).toBe("unknown-since");
			expect(since.command).toBe("get_entries");
			expect(since.success).toBe(false);

			// Malformed line goes through the same stdin pipe; the server must
			// report an uncorrelated parse error and keep serving later commands.
			sendRaw("this is not json");
			const parseError = await next();
			expect(parseError.command).toBe("parse");
			expect(parseError.success).toBe(false);
			expect(parseError.id).toBeUndefined();

			send({ type: "get_state", id: "after-malformed" });
			const ok = await next();
			expect(ok.id).toBe("after-malformed");
			expect(ok.success).toBe(true);
		});
	}, 60000);
});
