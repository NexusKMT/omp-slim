import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		const iframe = `<iframe id="f" name="payment" srcdoc="<!doctype html><input id='in'><div id='out'>ready</div><script>document.querySelector('#in').addEventListener('input',e=>document.querySelector('#out').textContent=e.target.value)</script>"></iframe>`;
		return new Response(
			`<!doctype html><title>${pathname}</title><body data-path="${pathname}">${iframe}<script>
				sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1));
				globalThis.confirmResult = null;
				globalThis.promptResult = null;
			</script></body>`,
			{ headers: { "content-type": "text/html" } },
		);
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
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
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-nav-frames-dialogs-test", signal });
}

function valueOf(result: { details?: unknown }): unknown {
	const { details } = result;
	if (!details || typeof details !== "object" || !("value" in details)) return undefined;
	return details.value;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser navigation, frames, dialogs, and tab listing", () => {
	test("drives history and SPA navigation without reloading", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "nav", url: `${baseUrl}/one` });
		await invoke({ action: "call", name: "nav", chain: [{ method: "goto", args: [`${baseUrl}/two`] }] });

		await invoke({ action: "call", name: "nav", chain: [{ method: "back", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/one`,
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "forward", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);

		const beforeReload = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "reload", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(Number(beforeReload) + 1);

		const beforePush = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		expect(
			valueOf(
				await invoke({ action: "call", name: "nav", chain: [{ method: "pushState", args: [`${baseUrl}/spa`] }] }),
			),
		).toBe(`${baseUrl}/spa`);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(beforePush);
	}, 30_000);

	test("auto-accepts alerts and explicitly settles confirm and prompt dialogs", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "dialogs", url: `${baseUrl}/dialogs` });
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => { alert("notice"); return "continued"; });',
				}),
			),
		).toBe("continued");

		const confirmDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.confirmResult = confirm("continue?"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(confirmDialog).toEqual({
			open: true,
			type: "confirm",
			message: "continue?",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.confirmResult);",
				}),
			),
		).toBe(true);

		const promptDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.promptResult = prompt("name?", "initial"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(promptDialog).toEqual({
			open: true,
			type: "prompt",
			message: "name?",
			defaultValue: "initial",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true, text: "Ada" }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.promptResult);",
				}),
			),
		).toBe("Ada");

		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: ["dismiss"] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => confirm("auto-dismissed"));',
				}),
			),
		).toBe(false);
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: [null] }],
		});
	}, 30_000);

	test("scopes helpers to iframe documents in run and direct call paths", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "frames", url: `${baseUrl}/frames` });
		const frameTree = valueOf(
			await invoke({ action: "call", name: "frames", chain: [{ method: "frames", args: [] }] }),
		) as Array<{ id: string; name: string; parentId: string | null; selector?: string }>;
		expect(frameTree.find(frame => frame.name === "payment")).toMatchObject({
			parentId: expect.any(String),
			selector: 'iframe[id="f"]',
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "frames",
					code: 'const f = await tab.frame("#f"); await f.fill("#in", "run"); return await f.text("#out");',
				}),
			),
		).toBe("run");
		await invoke({
			action: "call",
			name: "frames",
			chain: [
				{ method: "frame", args: ["#f"] },
				{ method: "fill", args: ["#in", "direct"] },
			],
		});
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "frames",
					chain: [
						{ method: "frame", args: ["#f"] },
						{ method: "text", args: ["#out"] },
					],
				}),
			),
		).toBe("direct");
	}, 30_000);

	test("lists managed tabs with live metadata", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "listed-one", url: `${baseUrl}/one`, persist: true });
		await invoke({ action: "open", name: "listed-two", url: `${baseUrl}/two` });
		const listed = valueOf(await invoke({ action: "tabs" })) as Array<{
			name: string;
			url: string;
			persist: boolean;
		}>;
		expect(listed.find(tab => tab.name === "listed-one")).toMatchObject({
			url: `${baseUrl}/one`,
			title: "/one",
			targetId: expect.any(String),
			kind: "headless",
			persist: true,
		});
		expect(listed.find(tab => tab.name === "listed-two")).toMatchObject({
			url: `${baseUrl}/two`,
			persist: false,
		});
	}, 30_000);

	test("stops the page load when a run is cancelled mid-goto", async () => {
		const requested = Promise.withResolvers<AbortSignal>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				requested.resolve(request.signal);
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{ action: "run", name: "cancelled", code: `await tab.goto("http://127.0.0.1:${slow.port}/slow");` },
				cancel.signal,
			);
			const request = await requested.promise;
			cancel.abort();
			// The cancel itself, not the interception-cleanup failure a still-loading page causes.
			await expect(run).rejects.toThrow("Operation aborted");
			// Chrome drops the request once the load is stopped; a load left running keeps waiting.
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("stopped");
				request.addEventListener("abort", () => resolve("stopped"));
			});
			expect(await Promise.race([dropped, Bun.sleep(5_000).then(() => "still loading")])).toBe("stopped");
		} finally {
			slow.stop(true);
		}
	}, 30_000);

	test("leaves the page's in-flight fetches alone when a run that is not navigating is cancelled", async () => {
		const pending = Promise.withResolvers<AbortSignal>();
		const waiting = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/pending") pending.resolve(request.signal);
				else waiting.resolve();
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-wait", url: `${baseUrl}/one` });
			await invoke({
				action: "run",
				name: "cancelled-wait",
				code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/pending");`,
			});
			const request = await pending.promise;
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-wait",
					code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/waiting");
						await wait(60_000);`,
				},
				cancel.signal,
			);
			await waiting.promise;
			cancel.abort();
			await expect(run).rejects.toThrow("Operation aborted");
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("dropped");
				request.addEventListener("abort", () => resolve("dropped"));
			});
			// Proving the fetch survives needs real time: nothing signals "Chrome did not cancel it".
			expect(await Promise.race([dropped, Bun.sleep(1_000).then(() => "pending")])).toBe("pending");
		} finally {
			slow.stop(true);
		}
	}, 30_000);

	test("does not call a cancelled run's page listeners for the requests the cancel stops", async () => {
		const requested = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				requested.resolve();
				const { promise, resolve } = Promise.withResolvers<Response>();
				request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })));
				return promise;
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-listener", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-listener",
					code: `page.on("requestfailed", () => {
							globalThis.failedCalls = (globalThis.failedCalls ?? 0) + 1;
							page.url();
						});
						await tab.goto("http://127.0.0.1:${slow.port}/slow");`,
				},
				cancel.signal,
			);
			await requested.promise;
			cancel.abort();
			await expect(run).rejects.toThrow("Operation aborted");
			const after = await invoke({
				action: "run",
				name: "cancelled-listener",
				code: "return { url: page.url(), failedCalls: globalThis.failedCalls ?? 0 };",
			});
			expect(valueOf(after)).toEqual({ url: `${baseUrl}/one`, failedCalls: 0 });
		} finally {
			slow.stop(true);
		}
	}, 30_000);
});
