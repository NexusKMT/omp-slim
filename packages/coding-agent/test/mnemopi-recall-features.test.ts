/**
 * `mnemopi.polyphonicRecall` and `mnemopi.enhancedRecall` must change what the
 * memory tools return, end to end: Settings -> `loadMnemopiConfig` -> per-bank
 * Mnemopi instances -> `recallEnhanced`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "recall-features-session";
const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

function startSession(overrides: Record<string, unknown>): { state: MnemopiSessionState; tools: ToolSession } {
	const dir = TempDir.createSync("@mnemopi-recall-features-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		...overrides,
	});
	const state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config: loadMnemopiConfig(settings, dir.path()),
		session: {
			sessionId: SESSION_ID,
			settings,
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never,
	});
	setMnemopiSessionState(state.session as never, state);
	states.push(state);
	const tools = {
		cwd: dir.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => SESSION_ID,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => state,
	} as unknown as ToolSession;
	return { state, tools };
}

async function retain(tools: ToolSession, ...contents: string[]): Promise<void> {
	await MemoryRetainTool.createIf(tools)!.execute("retain", { items: contents.map(content => ({ content })) });
}

async function recallText(tools: ToolSession, query: string): Promise<string> {
	const [block] = (await MemoryRecallTool.createIf(tools)!.execute("recall", { query })).content;
	if (block?.type !== "text") throw new Error("memory recall returned no text block");
	return block.text;
}

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose();
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("mnemopi.polyphonicRecall", () => {
	it("surfaces a graph-linked memory that the default recall misses", async () => {
		const texts: Record<string, string> = {};
		for (const polyphonicRecall of [false, true]) {
			const { tools } = startSession({
				"mnemopi.polyphonicRecall": polyphonicRecall,
				"mnemopi.proactiveLinking": true,
			});
			await retain(
				tools,
				"Alice owns the durable launch checklist",
				"The durable launch checklist lives in the Notion workspace",
			);
			texts[String(polyphonicRecall)] = await recallText(tools, "Alice");
		}

		expect(texts.false).toContain("Alice owns the durable launch checklist");
		expect(texts.false).not.toContain("Notion workspace");
		expect(texts.true).toContain("Alice owns the durable launch checklist");
		expect(texts.true).toContain("The durable launch checklist lives in the Notion workspace");
	});
});

describe("mnemopi.enhancedRecall", () => {
	it("serves repeated recalls from the cache, refreshes after a retain, and keys on recall options", async () => {
		const { state, tools } = startSession({ "mnemopi.enhancedRecall": true });
		const target = state.getScopedRecallTargets()[0];
		await retain(tools, "The deploy runbook lives in the ops wiki", "The deploy runbook links the pager rotation");

		const first = await recallText(tools, "deploy runbook");
		expect(await recallText(tools, "deploy runbook")).toBe(first);
		expect(target.memory.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 1 });

		await retain(tools, "The deploy runbook now covers rollbacks");
		expect(await recallText(tools, "deploy runbook")).toContain("The deploy runbook now covers rollbacks");
		expect(target.memory.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 2 });

		// Same query and bank as the tool, but a different result limit: must not reuse the tool's ranking.
		const narrow = await target.memory.recallEnhanced("deploy runbook", 1, {
			includeFacts: true,
			channelId: target.bank,
		});
		expect(narrow).toHaveLength(1);
		expect(target.memory.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 3 });
	});

	it("leaves recall uncached when the setting is off", async () => {
		const { state, tools } = startSession({ "mnemopi.enhancedRecall": false });
		await retain(tools, "The deploy runbook lives in the ops wiki");
		await recallText(tools, "deploy runbook");
		await recallText(tools, "deploy runbook");

		expect(state.getScopedRecallTargets()[0].memory.beam.caches.queryCache).toBeUndefined();
	});
});
