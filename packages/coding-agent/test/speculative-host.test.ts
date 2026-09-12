import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SpeculativeCommitContext, SpeculativeOperationContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"images.autoResize": false,
			"tools.approvalMode": "yolo",
			"tools.speculativeExecution.enabled": true,
		}),
	};
}

it("admits validated local reads without a risk-bearing operation grant", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
	temporaryDirectories.push(directory);
	await fs.writeFile(path.join(directory, "note.txt"), "content");
	const session = createSession(directory);
	const tool = new ReadTool(session);
	const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
	if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
	const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

	expect(
		await host.authorize({
			candidateId: "read-disabled",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: {
				type: "toolCall",
				id: "read-disabled",
				name: "read",
				arguments: { path: "note.txt" },
			},
			args: { path: "note.txt" },
			effect: assessment.effect,
		}),
	).toEqual({ allowed: true });
});

describe("CodingAgentSpeculativeExecutionHost", () => {
	it("rejects a read candidate whose source resource changed before claim", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const stableMtime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		await fs.utimes(target, stableMtime, stableMtime);
		const originalState = await fs.stat(target);
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
		if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "read-1",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "read-1", name: "read", arguments: { path: "note.txt" } },
			args: { path: "note.txt" },
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		await fs.writeFile(target, "update");
		await fs.utimes(target, originalState.atime, originalState.mtime);
		const rewrittenState = await fs.stat(target);
		expect({
			inode: rewrittenState.ino,
			mtimeMs: rewrittenState.mtimeMs,
			size: rewrittenState.size,
		}).toEqual({ inode: originalState.ino, mtimeMs: originalState.mtimeMs, size: originalState.size });
		const commit: SpeculativeCommitContext = {
			...context,
			physicalOutcome: { kind: "result", result: { content: [{ type: "text", text: "before" }] }, isError: false },
		};
		expect(await host.validate(commit)).toBe(false);
	});

	it("rejects bytes read during an ABA rewrite even after the original file is restored", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const stableMtime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		await fs.utimes(target, stableMtime, stableMtime);
		const originalState = await fs.stat(target);
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "note.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "aba-read",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "aba-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		await fs.writeFile(target, "during");
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		await fs.writeFile(target, "before");
		await fs.utimes(target, originalState.atime, originalState.mtime);
		const restoredState = await fs.stat(target);
		expect({
			inode: restoredState.ino,
			mtimeMs: restoredState.mtimeMs,
			size: restoredState.size,
		}).toEqual({ inode: originalState.ino, mtimeMs: originalState.mtimeMs, size: originalState.size });

		expect(await host.validate({ ...context, physicalOutcome })).toBe(false);
		await policy.discard?.({ ...context, reason: "test complete" });
	});

	it("releases local-read evidence after a successful commit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "before");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const args = { path: "note.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected local read assessment to succeed");
		const context: SpeculativeOperationContext = {
			candidateId: "committed-read",
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: "committed-read", name: "read", arguments: args },
			args,
			effect: assessment.effect,
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });

		expect(await host.authorize(context)).toMatchObject({ allowed: true });
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		const commitContext: SpeculativeCommitContext = { ...context, physicalOutcome };
		expect(await host.validate(commitContext)).toBe(true);
		expect(await host.commit(commitContext, async () => physicalOutcome.result)).toMatchObject({
			kind: "committed",
		});
		expect(await host.validate(commitContext)).toBe(false);
	});

	it("remains usable after one coordinator closes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "note.txt");
		await fs.writeFile(target, "content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
		if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		host.close();

		expect(
			await host.authorize({
				candidateId: "read-2",
				source: "direct",
				dependencies: [],
				tool,
				toolCall: { type: "toolCall", id: "read-2", name: "read", arguments: { path: "note.txt" } },
				args: { path: "note.txt" },
				effect: assessment.effect,
			}),
		).toMatchObject({ allowed: true });
	});

	it("touches no file content for reads denied by policy or lifecycle handlers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-host-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "approved content");
		await fs.writeFile(path.join(directory, "blob.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const policy = tool.speculation.finalized;
		if (!policy) throw new Error("read tool has no finalized speculation policy");
		const operationContext = (
			candidateId: string,
			target: string,
			effect: SpeculativeOperationContext["effect"],
		): SpeculativeOperationContext => ({
			candidateId,
			source: "direct",
			dependencies: [],
			tool,
			toolCall: { type: "toolCall", id: candidateId, name: "read", arguments: { path: target } },
			args: { path: target },
			effect,
		});

		// Assessment is metadata-only: a missing path and an unreadable-looking
		// binary both admit provisionally, without realpath/stat/sniff. Either
		// admission failed before content inspection moved behind authorization.
		const missing = await policy.assess({ args: { path: "missing.txt" } });
		if (!missing.eligible) throw new Error("expected provisional admission for a missing path");
		expect(missing.effect.resources[0].path).toBe(path.join(directory, "missing.txt"));
		const binary = await policy.assess({ args: { path: "blob.dat" } });
		if (!binary.eligible) throw new Error("expected provisional admission for binary content");

		// A denying lifecycle handler wins before any filesystem access: even
		// the missing path reports the handler, not an I/O failure, and the
		// binary reports the handler, not the sniff verdict.
		const denyingHost = new CodingAgentSpeculativeExecutionHost(session.settings, session, {
			hasHandlers: () => true,
		});
		await expect(
			denyingHost.authorize(operationContext("denied-missing", "missing.txt", missing.effect)),
		).resolves.toEqual({ allowed: false, reason: "active extension lifecycle handler" });
		await expect(
			denyingHost.authorize(operationContext("denied-binary", "blob.dat", binary.effect)),
		).resolves.toEqual({ allowed: false, reason: "active extension lifecycle handler" });
		// An explicit deny policy is refused the same way, before the sniff.
		const denyingPolicySession: ToolSession = {
			...session,
			settings: Settings.isolated({
				"images.autoResize": false,
				"tools.approvalMode": "yolo",
				"tools.speculativeExecution.enabled": true,
				"tools.approval": { read: "deny" },
			}),
		};
		const denyingPolicyHost = new CodingAgentSpeculativeExecutionHost(
			denyingPolicySession.settings,
			denyingPolicySession,
			{ hasHandlers: () => false },
		);
		await expect(
			denyingPolicyHost.authorize(operationContext("denied-binary", "blob.dat", binary.effect)),
		).resolves.toEqual({ allowed: false, reason: "tool approval is not auto-allow" });
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		await expect(host.authorize(operationContext("unsafe-binary", "blob.dat", binary.effect))).resolves.toEqual({
			allowed: false,
			reason: "local read target is unsafe",
		});

		// While an approved identical read still speculates and commits.
		const approved = await policy.assess({ args: { path: "note.txt" } });
		if (!approved.eligible) throw new Error("expected local read assessment to succeed");
		const context = operationContext("approved-read", "note.txt", approved.effect);
		await expect(host.authorize(context)).resolves.toEqual({ allowed: true });
		const physicalOutcome = await policy.execute(context, new AbortController().signal);
		if (physicalOutcome.kind !== "result") throw new Error("expected speculative read result");
		expect(await host.validate({ ...context, physicalOutcome })).toBe(true);
		await expect(
			host.commit({ ...context, physicalOutcome }, async () => physicalOutcome.result),
		).resolves.toMatchObject({ kind: "committed" });
	});
});
