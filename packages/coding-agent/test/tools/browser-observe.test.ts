import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BUTTONS = 200;
const PAGE = `data:text/html,${encodeURIComponent(
	Array.from(
		{ length: BUTTONS },
		(_, i) => `<button onclick="document.title = 'clicked ${i}'">Item ${i}</button>`,
	).join(""),
)}`;

describe("browser observe", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lists elements without resolving each one and resolves an id only when it is used",
		async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			const name = `observe-${process.pid}`;
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
			} as unknown as ToolSession;
			try {
				await acquireTab(name, browser, { url: PAGE, timeoutMs: 30_000 });
				const result = await runInTab(name, {
					code: `
						const client = page.mainFrame().client;
						const send = client.send;
						let resolved = 0;
						client.send = function (method, ...args) {
							if (method === "DOM.resolveNode") resolved++;
							return send.call(this, method, ...args);
						};
						let observation;
						try {
							observation = await tab.observe();
						} finally {
							client.send = send;
						}
						await (await tab.id(observation.elements[7].id)).click();
						const title = await tab.title();
						await tab.evaluate(() => document.querySelectorAll("button")[9].remove());
						let removed = "resolved";
						try {
							await tab.id(observation.elements[9].id);
						} catch (error) {
							removed = error.message;
						}
						return { listed: observation.elements.length, resolved, title, removed };
					`,
					timeoutMs: 20_000,
					session,
				});
				expect(result.returnValue).toEqual({
					listed: BUTTONS,
					resolved: 0,
					title: "clicked 7",
					removed: "Element id 10 is stale. Run tab.observe() again.",
				});
			} finally {
				await releaseTab(name, { kill: true });
				if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
			}
		},
		45_000,
	);
});
