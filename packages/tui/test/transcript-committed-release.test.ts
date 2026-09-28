import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { type Component, Container } from "@oh-my-pi/pi-tui";

const frame = { tick: 0, now: 0 };

/** A settled block that counts how often it was asked to drop its render caches. */
class ReleaseCountingBlock implements Component {
	invalidations = 0;
	readonly #rows: readonly string[];
	#finalized: boolean;

	constructor(rows: readonly string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	invalidate(): void {
		this.invalidations++;
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const THINKING =
	"Checking how the **renderer** wraps a long reasoning paragraph so that the replay has to reflow it.\n\nA second paragraph keeps the frozen stream prefix non-empty.";
const ANSWER = [
	"## Result",
	"",
	"The committed block keeps its message, so a replay can rebuild every row it ever showed at any width.",
	"",
	"- first item with `inline code` and **bold** text that wraps at narrow widths",
	"- second item",
	"",
	"```ts",
	"export function retire(entry: Entry): void {",
	"\tentry.state = 'committed';",
	"}",
	"```",
	"",
	"Closing paragraph after the fence, long enough to wrap when the terminal narrows.",
].join("\n");

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

/** Stream the answer through transient updates, then finalize, the way the live event path does. */
function streamedAssistant(): AssistantMessageComponent {
	const component = new AssistantMessageComponent();
	for (const fraction of [0.3, 0.6]) {
		component.updateContent(assistantMessage(ANSWER.slice(0, Math.floor(ANSWER.length * fraction))), {
			transient: true,
		});
		component.render(80);
	}
	component.updateContent(assistantMessage(ANSWER));
	component.markTranscriptBlockFinalized();
	return component;
}

const WRITE_CONTENT = Array.from(
	{ length: 30 },
	(_, index) => `export const value${index} = compute(${index}, "row ${index}");`,
).join("\n");

const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const liveTools: ToolExecutionComponent[] = [];

/** A write whose content streamed in (populating the incremental preview) before its result settled. */
function streamedWrite(): ToolExecutionComponent {
	const component = new ToolExecutionComponent("write", { path: "src/values.ts" }, {}, undefined, ui);
	liveTools.push(component);
	for (const lines of [10, 20, 30]) {
		const content = WRITE_CONTENT.split("\n").slice(0, lines).join("\n");
		component.updateArgs({ path: "src/values.ts", content });
		component.render(80);
	}
	component.setArgsComplete();
	component.setExecutionStarted();
	component.render(80);
	component.updateResult(
		{ content: [{ type: "text", text: "Successfully wrote src/values.ts" }], details: {}, isError: false },
		false,
	);
	return component;
}

/** Commit the only live block and return the exact rows the terminal received for it. */
function commitAll(transcript: TranscriptContainer, width: number): readonly string[] {
	transcript.renderViewport(width, 40, frame);
	const batch = transcript.peekFlushBatch(width);
	if (!batch) throw new Error("expected a retirement batch");
	transcript.acknowledgeFinalizedBatch(batch.id);
	expect(transcript.blockStates()).toEqual(["committed"]);
	return batch.rows;
}

function replay(transcript: TranscriptContainer, width: number): readonly string[] {
	transcript.beginReplay();
	const batch = transcript.peekReplayBatch(width);
	if (!batch) throw new Error("expected a replay batch");
	transcript.acknowledgeFinalizedBatch(batch.id);
	return batch.rows;
}

/**
 * The replay contract for a committed block whose caches were released: the
 * same width reproduces the bytes already in native history, and a new width
 * matches what an identical never-committed block renders there.
 */
function expectReplayContract(committed: Component, twin: Component): void {
	const transcript = new TranscriptContainer();
	transcript.addChild(committed);
	const live = committed.render(80);
	// Control: a live block hands back its memoized rows by reference.
	expect(committed.render(80)).toBe(live);

	const retired = commitAll(transcript, 80);
	const afterCommit = committed.render(80);
	expect(afterCommit).not.toBe(live);
	expect(afterCommit).toEqual(live);

	expect(replay(transcript, 80)).toEqual(retired);
	expect(replay(transcript, 52)).toEqual([...trimBlankEdges(twin.render(52)), ""]);
	const beforeReplay = committed.render(80);
	expect(replay(transcript, 80)).toEqual(retired);
	const afterReplay = committed.render(80);
	expect(afterReplay).not.toBe(beforeReplay);
	expect(afterReplay).toEqual(beforeReplay);
}

describe("committed transcript blocks release render caches", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		for (const tool of liveTools) tool.stopAnimation();
		liveTools.length = 0;
	});

	it("releases a block once when it commits and after every replay render, never while it is live", () => {
		const transcript = new TranscriptContainer();
		const settled = new ReleaseCountingBlock(["settled"], true);
		const active = new ReleaseCountingBlock(["active"], false);
		transcript.addChild(settled);
		transcript.addChild(active);
		transcript.renderViewport(80, 1, frame);

		const offered = transcript.peekFinalizedBatch(80, 1);
		if (!offered) throw new Error("expected a pressure retirement");
		// An unacknowledged offer can still be recomposed for a discarded frame.
		expect(settled.invalidations).toBe(0);
		transcript.acknowledgeFinalizedBatch(offered.id);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
		expect(settled.invalidations).toBe(1);

		replay(transcript, 60);
		expect(settled.invalidations).toBe(2);

		transcript.renderViewport(80, 10, frame);
		expect(active.invalidations).toBe(0);
		active.finalize();
		const final = transcript.peekFlushBatch(80);
		if (!final) throw new Error("expected the finalized block to retire");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(active.invalidations).toBe(1);
		expect(settled.invalidations).toBe(2);
	});

	it("replays a streamed assistant message byte-identically after release", () => {
		expectReplayContract(streamedAssistant(), streamedAssistant());
	});

	it("replays a streamed write tool card byte-identically after release", () => {
		expectReplayContract(streamedWrite(), streamedWrite());
	});
});

describe("write renderer streaming preview state", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("drops the incremental preview from the persistent render state once a result renders", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected the dark theme");
		const args = { path: "src/values.ts", content: WRITE_CONTENT };
		const renderState = { expanded: false, isPartial: true, argsComplete: true };
		writeToolRenderer.renderCall(args, renderState, uiTheme)?.render(80);
		// Control: the streaming call render keeps its incremental highlighter state here.
		expect(Object.getOwnPropertySymbols(renderState)).toHaveLength(1);

		const result = { content: [{ type: "text", text: "Successfully wrote src/values.ts" }], details: {} };
		// ToolExecutionComponent hands both renderers the same mutable render state.
		renderState.isPartial = false;
		const rows = writeToolRenderer.renderResult(result, renderState, uiTheme, args).render(80);

		expect(Object.getOwnPropertySymbols(renderState)).toHaveLength(0);
		const fresh = writeToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme, args);
		expect(rows).toEqual(fresh.render(80));
	});
});

/** Whether `target` becomes collectible within `deadlineMs`; a retained target never does. */
async function becomesCollectible(target: WeakRef<object>, deadlineMs = 3_000): Promise<boolean> {
	const deadline = performance.now() + deadlineMs;
	do {
		// WeakRef targets survive the job that created them; collect from a fresh turn and stack.
		await Bun.sleep(0);
		Bun.gc(true);
		if (target.deref() === undefined) return true;
	} while (performance.now() < deadline);
	return false;
}

describe("Container.invalidate", () => {
	it("stops pinning the rows its children last rendered", async () => {
		const rendered: WeakRef<readonly string[]>[] = [];
		const container = new Container();
		container.addChild({
			render: () => {
				const rows = [`row ${rendered.length}`];
				rendered.push(new WeakRef(rows));
				return rows;
			},
		});
		container.render(40);
		container.invalidate();

		expect(await becomesCollectible(rendered[0]!)).toBe(true);
		// The container stays live throughout, so only its own memo could have pinned the rows.
		expect(container.render(40)).toEqual(["row 1"]);
	});
});
