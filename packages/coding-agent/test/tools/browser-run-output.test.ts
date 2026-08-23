import { describe, expect, it } from "bun:test";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import {
	formatSelectorMatchHint,
	type HandleOpGuard,
	toActionableHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ElementHandle } from "puppeteer-core";

// Regression coverage for the invisible-output failure mode: `display("string")`,
// `console.log`, and `print` reach the runtime as `onText` chunks, which the browser
// embedders used to route to the debug log only — the tool result showed a bare
// "Ran code on tab" while the displayed text vanished.
describe("browser run output — stream text reaches the tool result", () => {
	it("surfaces buffered stream text as a display entry on finish", () => {
		const output = new RunOutput();
		output.pushText("plain string via display()\n");
		output.pushText("console.log line\n");

		expect(output.finish()).toEqual([{ type: "text", text: "plain string via display()\nconsole.log line" }]);
	});

	it("keeps stream text ordered around display() payloads", () => {
		const output = new RunOutput();
		output.pushText("before\n");
		output.pushDisplay({ type: "json", data: { a: 1 } });
		output.pushText("after\n");

		const entries = output.finish();
		expect(entries.map(e => (e.type === "text" ? e.text : e.type))).toEqual([
			"before",
			JSON.stringify({ a: 1 }, null, 2),
			"after",
		]);
	});

	it("flushes pending text before pre-built entries (screenshot captions) and emits images verbatim", () => {
		const output = new RunOutput();
		output.pushText("shot incoming\n");
		output.push({ type: "image", data: "aGk=", mimeType: "image/png" });
		output.pushDisplay({ type: "image", data: "eW8=", mimeType: "image/webp" });

		expect(output.finish()).toEqual([
			{ type: "text", text: "shot incoming" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "image", data: "eW8=", mimeType: "image/webp" },
		]);
	});

	it("returns no entries when nothing was displayed", () => {
		expect(new RunOutput().finish()).toEqual([]);
	});
});

// The tool docs promise `.fill()` on handles from tab.id()/tab.ref()/tab.waitFor();
// raw puppeteer ElementHandles only expose `.type()`. `input.fill is not a function`
// was a live failure.
describe("browser handle enrichment — fill()", () => {
	it("adds a fill() that clears the current value before typing", async () => {
		const calls: string[] = [];
		const node = { value: "old", focused: false };
		const stub = {
			evaluate: async (fn: (el: unknown) => unknown) => {
				calls.push("evaluate");
				fn({
					get value() {
						return node.value;
					},
					set value(v: string) {
						node.value = v;
					},
					focus: () => {
						node.focused = true;
					},
				});
			},
			type: async (text: string) => {
				calls.push("type");
				node.value += text;
			},
		} as unknown as ElementHandle;

		await toActionableHandle(stub).fill("fresh");

		expect(calls).toEqual(["evaluate", "type"]);
		expect(node.focused).toBe(true);
		expect(node.value).toBe("fresh");
	});
});

// Regression (#9535): handles from tab.id()/tab.ref()/tab.waitFor() used to return raw
// puppeteer methods that ran outside the per-op guard, so a stalled `(await tab.id(n)).click()`
// consumed the whole 30s cell instead of failing fast with a named per-op error. A guard now
// routes each interactive method through the same fail-fast wrapper as tab.click(selector).
describe("browser handle enrichment — guarded actions", () => {
	// Minimal stand-in for #runOp: names the op, installs a per-op deadline, and rewrites an
	// abort into the same `<label> timed out after <ms>ms` shape the real guard surfaces.
	const makeGuard = (perOpMs: number): { guard: HandleOpGuard; labels: string[] } => {
		const labels: string[] = [];
		const guard: HandleOpGuard = (label, fn) => {
			labels.push(label);
			const timeout = AbortSignal.timeout(perOpMs);
			return fn(timeout).catch((err: unknown) => {
				if (timeout.aborted) throw new Error(`${label} timed out after ${perOpMs}ms`);
				throw err;
			});
		};
		return { guard, labels };
	};

	it("fails a stalled handle.click() fast with a named error instead of hanging", async () => {
		const stub = {
			click: () => new Promise<void>(() => {}), // never settles — a busy popup/navigation stall
			type: async () => {},
			evaluate: async () => {},
		} as unknown as ElementHandle;
		const { guard, labels } = makeGuard(50);

		await expect(toActionableHandle(stub, guard).click()).rejects.toThrow("handle.click() timed out after 50ms");
		expect(labels).toEqual(["handle.click()"]);
	});

	it("passes arguments and return values through the guarded method unchanged", async () => {
		let calls = 0;
		const stub = {
			select: async (...values: string[]) => {
				calls++;
				return values;
			},
			type: async () => {},
			evaluate: async () => {},
		} as unknown as ElementHandle;
		const { guard, labels } = makeGuard(1_000);

		expect(await toActionableHandle(stub, guard).select("a", "b")).toEqual(["a", "b"]);
		expect(calls).toBe(1);
		expect(labels).toEqual(["handle.select()"]);
	});

	it("runs the guarded fill as a single op without re-entering the wrapped type()", async () => {
		const node = { value: "old", focused: false };
		const stub = {
			evaluate: async (fn: (el: unknown) => unknown) => {
				fn({
					get value() {
						return node.value;
					},
					set value(v: string) {
						node.value = v;
					},
					focus: () => {
						node.focused = true;
					},
				});
			},
			type: async (text: string) => {
				node.value += text;
			},
		} as unknown as ElementHandle;
		const { guard, labels } = makeGuard(1_000);

		await toActionableHandle(stub, guard).fill("fresh");

		expect(node.value).toBe("fresh");
		expect(node.focused).toBe(true);
		// fill() drives type() internally via the raw method, so it is guarded once, not nested.
		expect(labels).toEqual(["handle.fill()"]);
	});
});

// A selector op's fail-fast timeout must diagnose *why*: a missing element (consent
// wall, wrong page) needs a different recovery than a present-but-unactionable one.
describe("browser selector timeout hint", () => {
	it("points at observe/ariaSnapshot when nothing matches", () => {
		expect(formatSelectorMatchHint(0)).toContain("matches no elements");
		expect(formatSelectorMatchHint(0)).toContain("tab.observe()");
	});

	it("reports the match count when elements exist but the action stalled", () => {
		const hint = formatSelectorMatchHint(3);
		expect(hint).toContain("3 element(s)");
		expect(hint).toContain("hidden or covered");
	});
});
