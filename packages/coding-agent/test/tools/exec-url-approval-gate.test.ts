import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "../helpers/bundled-model";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { execUrlProtocol } from "../helpers/exec-url-protocol";

beforeEach(() => {
	InternalUrlRouter.instance().register(execUrlProtocol);
});

afterEach(() => {
	InternalUrlRouter.instance().unregister(execUrlProtocol.scheme);
});

// Exercise the production approval wrapper: an exec-tier protocol requires
// approval while equivalent local-path calls can run at read/write tiers.
const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

const APPROVAL_RE = /requires approval but no interactive UI available/;

describe("execfs:// tools are exec-gated through the production approval wrapper", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-exec-url-approval-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(cwd, "local.txt"), "hello-local\n");
		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "grep", "glob", "write"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; the OS reclaims the temp dir
		}
	});

	function tool(name: "read" | "grep" | "glob" | "write") {
		const found = session.getToolByName(name);
		if (!found) throw new Error(`Expected ${name} tool`);
		return found;
	}

	function ctx(approvalMode: "always-ask" | "write"): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": approvalMode }),
		} as AgentToolContext;
	}

	it("read: execfs:// requires approval (exec), a local path runs (read)", async () => {
		await expect(
			tool("read").execute(
				"r-exec-url",
				{ path: "execfs://localhost/etc/hostname" },
				undefined,
				undefined,
				ctx("always-ask"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("read").execute("r-local", { path: "local.txt" }, undefined, undefined, ctx("always-ask"));
		expect(JSON.stringify(ok.content)).toContain("hello-local");
	});

	it("grep: a delimited execfs:// entry requires approval before path expansion", async () => {
		// The wrapper sees `path` verbatim (pre-expansion), so the substring scan must trip exec here.
		await expect(
			tool("grep").execute(
				"s-exec-url",
				{ pattern: "x", path: "local.txt,execfs://localhost/etc/hosts" },
				undefined,
				undefined,
				ctx("always-ask"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("grep").execute(
			"s-local",
			{ pattern: "hello", path: "." },
			undefined,
			undefined,
			ctx("always-ask"),
		);
		expect(ok).toBeDefined();
	});

	it("glob: an execfs:// path requires approval (exec), a local glob runs (read)", async () => {
		await expect(
			tool("glob").execute(
				"g-exec-url",
				{ path: "execfs://localhost/etc" },
				undefined,
				undefined,
				ctx("always-ask"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("glob").execute("g-local", { path: "*.txt" }, undefined, undefined, ctx("always-ask"));
		expect(JSON.stringify(ok.content)).toContain("local.txt");
	});

	it("write: execfs:// requires approval (exec), a local write runs (write tier, write mode)", async () => {
		await expect(
			tool("write").execute(
				"w-exec-url",
				{ path: "execfs://localhost/tmp/x", content: "x" },
				undefined,
				undefined,
				ctx("write"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("write").execute(
			"w-local",
			{ path: "out.txt", content: "data\n" },
			undefined,
			undefined,
			ctx("write"),
		);
		expect(JSON.stringify(ok.content)).toContain("out.txt");
	});
});
