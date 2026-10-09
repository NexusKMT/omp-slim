import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, holdBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import {
	installWebMcp,
	type WebMcpEventsResult,
	type WebMcpInvokeResult,
	type WebMcpListResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webmcp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createBrowserHost() {
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
	return (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "browser-webmcp-test" });
}

function call(name: string, method: string, args: unknown[] = []) {
	return name.length > 0
		? { action: "call", name, chain: [{ method, args }] }
		: { action: "call", chain: [{ method, args }] };
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		throw new Error("Browser call returned no value");
	}
	return details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser WebMCP helpers", () => {
	it("discovers, invokes, bounds trust, and reports page-side registrations", async () => {
		const invoke = createBrowserHost();
		const html = `<!doctype html>
<html><head><title>loading</title></head><body><script>
(async () => {
  window.webmcpSurface = navigator.modelContext?.constructor?.name === "ModelContext" ? "native" : "hook-polyfill";
  await navigator.modelContext.registerTool({
    name: "sum_values",
    description: "Adds two values from the page.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"]
    },
    annotations: { readOnlyHint: true },
    execute({ left, right }) { return { total: left + right }; }
  });
  await navigator.modelContext.registerTool({
    name: "large_result",
    description: "Returns an oversized page result.",
    inputSchema: { type: "object" },
    execute() { return "x".repeat(70 * 1024); }
  });
  await navigator.modelContext.registerTool({
    name: "throw_page_error",
    description: "Throws page-provided text.",
    inputSchema: { type: "object" },
    execute() { throw new Error("PAGE_SENTINEL_FAILURE"); }
  });
  document.title = "registered";
})();
</script></body></html>`;
		const url = `data:text/html,${encodeURIComponent(html)}`;
		await invoke({ action: "open", name: "webmcp", url });

		const surface = valueFrom<string>(await invoke(call("webmcp", "evaluate", ["window.webmcpSurface"])));
		// Chrome 150 with WebMCP flags does not expose its secure-context API to data: pages; the preload polyfill runs.
		expect(surface).toBe("hook-polyfill");

		const summary = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList")));
		expect(summary).toMatchObject({
			status: "ready",
			truncated: false,
			untrusted: true,
		});
		expect(summary.tools.map(tool => tool.name)).toEqual(["large_result", "sum_values", "throw_page_error"]);
		expect(summary.tools.every(tool => tool.inputSchema === undefined)).toBe(true);

		const detail = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList", [{ name: "sum_values" }])));
		expect(detail.tools).toEqual([
			expect.objectContaining({
				name: "sum_values",
				inputSchema: expect.objectContaining({ type: "object", required: ["left", "right"] }),
				annotations: { readOnlyHint: true },
				untrusted: true,
			}),
		]);

		const result = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["sum_values", { left: 20, right: 22 }])),
		);
		expect(result).toEqual({ ok: true, result: { total: 42 }, untrusted: true });

		const largeResult = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["large_result", {}])),
		);
		expect(largeResult).toMatchObject({ ok: true, truncated: true, untrusted: true });
		expect(Buffer.byteLength(JSON.stringify(largeResult), "utf8")).toBeLessThanOrEqual(64 * 1024);

		const failure = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["throw_page_error", {}])),
		);
		expect(failure).toMatchObject({ ok: false, untrusted: true });
		if (failure.ok) throw new Error("Expected page tool failure");
		expect(failure.error).toContain("BEGIN UNTRUSTED WEBMCP CONTENT");
		expect(failure.error).toContain("PAGE_SENTINEL_FAILURE");
		expect(failure.error).toContain("END UNTRUSTED WEBMCP CONTENT");

		const events = valueFrom<WebMcpEventsResult>(await invoke(call("webmcp", "webmcpEvents")));
		expect(events).toMatchObject({ untrusted: true, truncated: false });
		expect(events.events.map(event => [event.type, event.name])).toEqual([
			["registered", "large_result"],
			["registered", "sum_values"],
			["registered", "throw_page_error"],
		]);
		await invoke({ action: "close", name: "webmcp", kill: true });
	}, 30_000);

	it("keeps a page alive whose same-site iframe is touched before it navigates", async () => {
		const invoke = createBrowserHost();
		// Same site, other origin: the iframe shares the parent's renderer.
		using child = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response("<!doctype html><title>child</title>child", { headers: { "content-type": "text/html" } }),
		});
		using parent = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response(
					`<!doctype html><title>parent</title><body><script>
const frame = document.createElement("iframe");
frame.onload = () => { document.title = "iframe loaded"; };
frame.src = "http://localhost:${child.port}/";
document.body.appendChild(frame);
// Touching the window before it navigates gives its initial empty document a script context.
frame.contentWindow.location.href;
navigator.modelContext.registerTool({
  name: "page_title",
  description: "Returns the page title.",
  inputSchema: { type: "object" },
  execute() { return { title: document.title }; }
});
</script></body>`,
					{ headers: { "content-type": "text/html" } },
				),
		});

		await invoke({ action: "open", name: "webmcp-iframe", url: `http://localhost:${parent.port}/`, timeout: 10 });
		expect(valueFrom<string>(await invoke(call("webmcp-iframe", "evaluate", ["document.title"])))).toBe(
			"iframe loaded",
		);
		const listed = valueFrom<WebMcpListResult>(await invoke(call("webmcp-iframe", "webmcpList")));
		expect(listed.tools.map(tool => tool.name)).toEqual(["page_title"]);
		const result = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp-iframe", "webmcpInvoke", ["page_title", {}])),
		);
		expect(result).toEqual({ ok: true, result: { title: "iframe loaded" }, untrusted: true });
		await invoke({ action: "close", name: "webmcp-iframe", kill: true });
	}, 30_000);

	// The hook reaches a loaded page when omp attaches to it: a context the page set up itself is
	// patched at once rather than waiting for a getter read, as a platform context is.
	it.each([
		{
			setup: "a non-configurable accessor",
			define: `Object.defineProperty(navigator, "modelContext", { get: () => window.pageContext });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "an accessor the page read before attach",
			define: `Object.defineProperty(navigator, "modelContext", { configurable: true, get: () => window.pageContext });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
		{
			setup: "an accessor that yields no context",
			define: `Object.defineProperty(navigator, "modelContext", { configurable: true, get: () => undefined });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a prototype accessor the page read before attach",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => window.pageContext });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
		{
			setup: "a prototype accessor that yields no context",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => undefined });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a bound prototype accessor the page read before attach",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: function () { return window.pageContext; }.bind(null) });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
	])(
		"mirrors a tool registered after attach on a page whose modelContext is $setup",
		async ({ define, registerOn }) => {
			const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
			holdBrowser(handle);
			const page = await handle.browser.newPage();
			try {
				await page.goto("data:text/html,<title>page-owned context</title>");
				// The realm installWebMcp hooks in existing frames.
				const realm = page.mainFrame().mainRealm();
				await realm.evaluate(`window.pageContext = { registerTool() {}, unregisterTool() {} };\n${define}\nnull;`);
				const controller = await installWebMcp(page);
				await realm.evaluate(
					`${registerOn}.registerTool({ name: "page_owned", description: "Page tool.", inputSchema: { type: "object" }, execute: () => ({ value: 42 }) })`,
				);
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["page_owned"]);
				expect(await controller.invoke("page_owned", {})).toEqual({
					ok: true,
					result: { value: 42 },
					untrusted: true,
				});
				await controller.dispose();
			} finally {
				await page.close();
				await releaseBrowser(handle, { kill: false });
			}
		},
	);
});
