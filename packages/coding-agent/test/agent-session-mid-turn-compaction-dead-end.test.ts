import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const noopSchema = z.object({});
const noopTool: AgentTool<typeof noopSchema, undefined> = {
	name: "noop",
	label: "No-op",
	description: "Continue the scripted tool loop",
	parameters: noopSchema,
	async execute() {
		return { content: [{ type: "text", text: "continued" }], details: undefined };
	},
};

const DEAD_END_WARNING = "Compaction freed too little context to make progress";

/** One threshold-tripping tool-call turn. */
function toolTurn(id: string): MockResponse {
	return { content: [{ type: "toolCall", id, name: "noop", arguments: {} }], usage: { input: 190_000 } };
}

describe("AgentSession mid-turn compaction dead-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
	});

	async function createSession(options: {
		responses: MockResponse[];
		/** Optional `session_before_compact` short-circuit so a viable compaction makes no LLM call. */
		shortCircuitCompaction?: boolean;
	}): Promise<{ notices: string[]; compactionStarts: number[]; compactionResults: number }> {
		tempDir = TempDir.createSync("@pi-mid-turn-compaction-dead-end-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({ responses: options.responses });
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([mock]);

		let extensionRunner: ExtensionRunner | undefined;
		const sessionManager = SessionManager.inMemory(tempDir.path());
		if (options.shortCircuitCompaction) {
			const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
			fs.mkdirSync(extensionsDir, { recursive: true });
			const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
			fs.writeFileSync(
				extensionPath,
				[
					"export default function(pi) {",
					'\tpi.on("session_before_compact", async (event) => ({',
					"\t\tcompaction: {",
					'\t\t\tsummary: "compacted",',
					"\t\t\tshortSummary: undefined,",
					"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
					"\t\t\ttokensBefore: event.preparation.tokensBefore,",
					"\t\t\tdetails: {},",
					"\t\t},",
					"\t}));",
					"}",
				].join("\n"),
			);
			const loaded = await loadExtensions([extensionPath], tempDir.path());
			extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [noopTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 100_000,
			"compaction.midTurnEnabled": true,
			"compaction.autoContinue": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[noopTool.name, noopTool]]),
			extensionRunner,
		});

		const notices: string[] = [];
		const compactionStarts: number[] = [];
		const compactionResults = 0;
		const state = { notices, compactionStarts, compactionResults };
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			else if (event.type === "auto_compaction_start") compactionStarts.push(1);
			else if (event.type === "auto_compaction_end" && event.result) state.compactionResults++;
		});
		return state;
	}

	it("attempts and warns once per oversized tool-loop turn when no cut point ever appears", async () => {
		// The genuinely-unrecoverable shape: prepareCompaction can never find a cut
		// point (the whole oversized region is the most recent turn). Re-running the
		// rescue and re-emitting the warning on every following tool boundary is
		// wasted work, so it must fire exactly once per turn — and re-arm cleanly
		// for the next user turn.
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		const state = await createSession({
			responses: [
				toolTurn("noop-1"),
				toolTurn("noop-2"),
				{ content: ["done"] },
				toolTurn("noop-3"),
				toolTurn("noop-4"),
				{ content: ["done again"] },
			],
		});

		await session.prompt("Run both tools before answering");
		expect(state.notices).toEqual([expect.stringContaining(DEAD_END_WARNING)]);
		expect(state.compactionStarts).toHaveLength(1);

		await session.prompt("Run two more tools before answering");
		expect(state.notices).toEqual([
			expect.stringContaining(DEAD_END_WARNING),
			expect.stringContaining(DEAD_END_WARNING),
		]);
		expect(state.compactionStarts).toHaveLength(2);
	});

	it("re-attempts compaction once a later tool result creates a cut point", async () => {
		// Reviewer regression (#7153): the live context keeps growing, so a dead end
		// at the first boundary MUST NOT permanently suppress maintenance. Once a
		// later, smaller turn lets prepareCompaction cut before the now-older
		// oversized turn, compaction has to run instead of parking until overflow.
		let preparable = false;
		const branch = () => session.sessionManager.getBranch();
		const fakePreparation = (): compactionModule.CompactionPreparation => {
			const entries = branch();
			const firstKeptEntryId = entries[entries.length - 1]?.id;
			if (!firstKeptEntryId) throw new Error("branch has no entry to keep");
			return {
				firstKeptEntryId,
				messagesToSummarize: [{ role: "user", content: "old", timestamp: Date.now() }],
				turnPrefixMessages: [],
				recentMessages: [],
				isSplitTurn: false,
				tokensBefore: 190_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: session.settings.getGroup("compaction"),
			};
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockImplementation(() =>
			preparable ? fakePreparation() : undefined,
		);

		const state = await createSession({
			responses: [toolTurn("noop-1"), toolTurn("noop-2"), toolTurn("noop-3"), { content: ["done"] }],
			shortCircuitCompaction: true,
		});
		// The first boundary hits the no-preparation dead end (nothing summarizable
		// and the elide rescue frees nothing). Once its warning lands, mark the
		// context "preparable" to model the later cut point appearing.
		vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});
		vi.spyOn(session, "getContextUsage").mockImplementation(() =>
			preparable
				? { tokens: 1_000, contextWindow: 200_000, percent: 0.5 }
				: { tokens: 190_000, contextWindow: 200_000, percent: 95 },
		);
		session.subscribe(event => {
			if (event.type === "notice" && event.message.includes(DEAD_END_WARNING)) preparable = true;
		});

		await session.prompt("Run three tools before answering");

		// First dead end warned once; a later boundary re-attempted (start #2) and,
		// with a cut point now available, produced a real compaction result instead
		// of staying parked.
		expect(state.notices.filter(m => m.includes(DEAD_END_WARNING))).toHaveLength(1);
		expect(state.compactionStarts.length).toBeGreaterThanOrEqual(2);
		expect(state.compactionResults).toBeGreaterThanOrEqual(1);
	});
});
