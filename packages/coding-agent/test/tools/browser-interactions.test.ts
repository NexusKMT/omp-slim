import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const TAB_NAME = `interactions-${crypto.randomUUID()}`;
const STARVED_TAB_NAME = `starved-${crypto.randomUUID()}`;
let tempDir = "";
let uploadPath = "";

const html = `<!doctype html>
<style>
body { margin: 0; font: 16px sans-serif; }
#covered { position: absolute; left: 20px; top: 20px; width: 140px; height: 48px; }
#overlay { position: fixed; left: 20px; top: 20px; width: 140px; height: 48px; z-index: 10; }
#point { position: absolute; left: 300px; top: 20px; width: 100px; height: 50px; }
#drop, #highlight { margin-top: 100px; width: 180px; height: 50px; border: 1px solid black; }
</style>
<button id="covered">Covered target</button><div id="overlay"></div>
<label><input id="check" type="checkbox"> Toggle</label>
<button id="double">Double</button><input id="keys">
<button id="point">Point</button><div id="drop">Drop zone</div><div id="highlight">Highlight</div>
<script>
window.results = { covered: 0, doubles: 0, keys: [], point: 0, dropped: "" };
document.querySelector("#covered").addEventListener("click", () => results.covered++);
document.querySelector("#double").addEventListener("dblclick", () => results.doubles++);
document.querySelector("#keys").addEventListener("keydown", event => results.keys.push(event.key + ":" + event.shiftKey));
document.querySelector("#point").addEventListener("click", () => results.point++);
document.querySelector("#drop").addEventListener("dragover", event => event.preventDefault());
document.querySelector("#drop").addEventListener("drop", event => {
  event.preventDefault();
  results.dropped = event.dataTransfer.files[0]?.name || "";
});
</script>`;

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object") throw new Error("Browser result did not include details");
	return ("value" in details ? details.value : undefined) as T;
}

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-interactions-"));
	uploadPath = path.join(tempDir, "drop-fixture.txt");
	await Bun.write(uploadPath, "drop contents");
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser click timeouts", () => {
	test("says why a click that never became clickable timed out", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-unclickable" };
		const tabName = `unclickable-${crypto.randomUUID()}`;
		const unclickableHtml = `<!doctype html><button id="hidden" style="display:none">Hidden</button><button id="faded" style="opacity:0">Faded</button>
<button class="multi" style="display:none">First</button><button class="multi">Second</button>
<button id="swap">Swap</button>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(unclickableHtml)}` },
			context,
		);
		try {
			const attempt = async (call: string) => {
				const result = await prelude.invoke(
					{
						action: "run",
						name: tabName,
						code: `try {
	await ${call};
	return "clicked";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
						// A 3 s cell caps the per-op deadline at 2 s.
						timeout: 3,
					},
					context,
				);
				return valueFrom<string>(result);
			};
			// display:none has no box (never stable); opacity:0 is stable but refused.
			const hidden = await attempt(`tab.click("#hidden")`);
			expect(hidden).toMatch(/^tab\.click\("#hidden"\) timed out after \d+ms/);
			expect(hidden).toContain("last check: display:none");
			expect(await attempt(`tab.click("#faded")`)).toContain("last check: opacity:0");
			// The count tells the caller the first of several matches is the hidden one.
			const multi = await attempt(`tab.dblclick(".multi")`);
			expect(multi).toContain("last check: display:none");
			expect(multi).toContain("matches 2 element(s)");
			// The page replaces the element (as a re-render would) after the caller resolved its handle.
			expect(
				await attempt(`(async () => {
	const { elements } = await tab.observe();
	const swap = await tab.id(elements.find(element => element.name === "Swap").id);
	await tab.evaluate(() => { const old = document.querySelector("#swap"); old.replaceWith(old.cloneNode(true)); });
	await swap.click();
})()`),
			).toContain("last check: detached");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser interaction parity", () => {
	test("clicks a link that wraps across two lines on the link, not on its paragraph, on puppeteer and Tern", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-wrapped-link" };
		const tabName = `wrapped-${crypto.randomUUID()}`;
		const wrappedHtml = `<!doctype html><p id="para" style="width:33ch;font:16px/20px monospace;margin:0">aaaaaaaaaaaaaaaaaaaaaaa <a id="link" href="#">wrapped link</a> bbbbbbbbbbbbbbbbbbbbbbbbbbbb</p>
<script>window.clicked = []; document.addEventListener("click", event => { clicked.push(event.target.id); event.preventDefault(); });</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(wrappedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					// The Tern page kit is plain page script, so its aim point is checked on this page.
					code: `const fragments = await tab.evaluate(() => document.querySelector("#link").getClientRects().length);
await tab.click("#link");
await tab.evaluate(${JSON.stringify(`(function () {\n${TERN_KIT_SOURCE}\n})()`)});
const ternHit = await tab.evaluate(async () => {
	const target = await globalThis.__ompTernKit.target({ engine: "css", query: "#link" }, "click");
	return target.ok ? document.elementFromPoint(target.x, target.y)?.id : target.reason;
});
return { fragments, clicked: await tab.evaluate(() => window.clicked), ternHit };`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<{ fragments: number; clicked: string[]; ternHit: string }>(result)).toEqual({
				fragments: 2,
				clicked: ["link"],
				ternHit: "link",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("guards covered clicks and drives keyboard, pointer, drop-zone, checked-state, and highlight interactions", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-interactions" });
		const call = async (method: string, args: unknown[] = []): Promise<unknown> => {
			const result = await invoke({ action: "call", name: TAB_NAME, chain: [{ method, args }] });
			return valueFrom<unknown>(result);
		};

		await invoke({
			action: "open",
			name: TAB_NAME,
			url: `data:text/html,${encodeURIComponent(html)}`,
		});
		try {
			const blocked = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `try {
	await tab.click("#covered");
	return "clicked";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
				timeout: 10,
			});
			expect(valueFrom<string>(blocked)).toBe('tab.click("#covered") blocked: covered by <div#overlay>');
			await call("evaluate", ["document.querySelector('#overlay').remove()"]);
			await call("click", ["#covered"]);

			await call("check", ["#check"]);
			await call("check", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(true);
			await call("uncheck", ["#check"]);
			await call("uncheck", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(false);

			await call("dblclick", ["#double"]);
			await call("focus", ["#keys"]);
			await call("keyDown", ["Shift"]);
			await call("press", ["a"]);
			await call("keyUp", ["Shift"]);
			await call("clickAt", [350, 45]);
			await call("uploadFile", ["#drop", uploadPath]);

			const highlight = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `const pending = tab.highlight("#highlight", { duration: 1000 });
// The overlay is injected asynchronously and removed once the helper's
// host-side hold elapses, so wait for the node instead of sampling the count.
await tab.waitForSelector("[data-omp-highlight-overlay]", { timeout: 5000 });
const during = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
await pending;
const after = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
return { during, after };`,
			});
			expect(valueFrom<{ during: number; after: number }>(highlight)).toEqual({ during: 1, after: 0 });

			const results = await call("evaluate", ["window.results"]);
			expect(results).toMatchObject({
				covered: 1,
				doubles: 1,
				keys: ["Shift:true", "a:true"],
				point: 1,
				dropped: "drop-fixture.txt",
			});
		} finally {
			await invoke({ action: "close", name: TAB_NAME, kill: true }).catch(() => undefined);
		}
	}, 30_000);

	// Backgrounded headless tabs deliver no animation frames, which stalls every
	// Puppeteer `Locator` precondition (viewport/stability/enabled) forever.
	// Virtual time pinned at "pause" reproduces that state deterministically.
	test("fills page and frame selectors on a tab that produces no animation frames", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const starvedHtml = `<!doctype html><input id="q" value="stale"><div id="editable" contenteditable>stale</div>
<iframe id="inner" srcdoc='<!doctype html><input id="deep" value="stale"><button id="go" onclick="this.dataset.clicked=1">Go</button>'></iframe>`;
		const context = { session, toolCallId: "browser-starved" };
		await prelude.invoke(
			{ action: "open", name: STARVED_TAB_NAME, url: `data:text/html,${encodeURIComponent(starvedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: STARVED_TAB_NAME,
					code: `await tab.waitFor("#inner");
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
await tab.fill("#q", "typed");
const inner = await tab.frame("#inner");
await inner.fill("#deep", "nested");
await tab.fill("#editable", "replaced");
await inner.click("#go");
return {
	page: await tab.value("#q"),
	frame: await inner.value("#deep"),
	editable: await tab.text("#editable"),
	clicked: await inner.attr("#go", "data-clicked"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ page: string; frame: string; editable: string; clicked: string }>(result)).toEqual({
				page: "typed",
				frame: "nested",
				editable: "replaced",
				clicked: "1",
			});
		} finally {
			await prelude.invoke({ action: "close", name: STARVED_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("checks custom-styled checkboxes where their drawn box is, for the left button only", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-custom-checkbox" };
		const tabName = `custom-checkbox-${crypto.randomUUID()}`;
		// #terms, #nested and #shadowed hold a link or button inside the label, which no click may follow.
		const customHtml = `<!doctype html><style>label { position: relative; display: block; padding: 4px 24px } input { position: absolute; left: 4px; top: 4px; margin: 0 } .box { position: absolute; left: 2px; top: 2px; width: 18px; height: 18px; background: #fff; border: 1px solid #333 }</style>
<label><input id="faded" type="checkbox" style="opacity:0"><span style="position:absolute;left:4px;top:4px;width:14px;height:14px;border:1px solid #333"></span>Faded option</label>
<label><input id="covered" type="checkbox"><span class="box"></span>Covered option</label>
<label style="display:inline-block"><input id="terms" type="checkbox" style="opacity:0"><span class="box"></span>I agree to the <a href="#terms-page">Terms of Service and Privacy Policy</a></label>
<label><input id="nested" type="checkbox"><button class="box" type="button"></button>Nested option</label>
<label><input id="shadowed" type="checkbox"><a class="box" href="#tos"><x-icon></x-icon></a>Shadowed option</label>
<script>customElements.define("x-icon", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<span style="display:block;width:18px;height:18px"></span>'; } });</script>
<script>
window.changes = 0;
window.links = 0;
document.addEventListener("change", event => { if (event.isTrusted) changes++; });
document.addEventListener("click", event => { if (event.target.closest("a")) { links++; event.preventDefault(); } });
</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(customHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.check("#faded");
await tab.check("#covered");
await tab.uncheck("#covered");
await tab.click("#covered");
await tab.check("#terms");
const refusal = async click => {
	try {
		await click();
		return "pressed";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};
const nested = await refusal(() => tab.click("#nested"));
const shadowed = await refusal(() => tab.click("#shadowed"));
const { elements } = await tab.observe();
const covered = await tab.id(elements.find(element => element.name === "Covered option").id);
const rightClick = await refusal(() => covered.click({ button: "right" }));
const state = await tab.evaluate(() => ({
	faded: document.querySelector("#faded").checked,
	covered: document.querySelector("#covered").checked,
	terms: document.querySelector("#terms").checked,
	changes: window.changes,
	links: window.links,
}));
return { ...state, nested, shadowed, rightClick };`,
					timeout: 15,
				},
				context,
			);
			const value = valueFrom<Record<string, unknown>>(result);
			expect(value).toMatchObject({
				faded: true,
				covered: true,
				terms: true,
				// One trusted change per call: a state forced through the DOM fires an untrusted one.
				changes: 5,
				links: 0,
			});
			expect(value.nested).toContain("covered by <button.box>");
			expect(value.shadowed).toContain("covered by");
			expect(value.rightClick).toContain("covered by <span.box>");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
});
