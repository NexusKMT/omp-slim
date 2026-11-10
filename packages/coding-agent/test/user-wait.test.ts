import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { trackUserWaits } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/user-wait";

describe("trackUserWaits", () => {
	it("re-reads an optional dialog getter on every access", async () => {
		// Like the RPC UI context's `askDialog`, which `set_ask_dialog` turns off: once off, the ask must fall back to
		// `select`, not keep the wrapper of the dialog it read while on.
		const tracked: string[] = [];
		const rpcLike = {
			enabled: true,
			get askDialog(): ExtensionUIContext["askDialog"] {
				if (!this.enabled) return undefined;
				return async () => undefined;
			},
		};
		const ui = trackUserWaits(rpcLike as unknown as ExtensionUIContext, dialog => {
			tracked.push("ask");
			return dialog();
		});
		await ui.askDialog?.([]);
		expect(tracked).toEqual(["ask"]);
		rpcLike.enabled = false;
		expect(ui.askDialog).toBeUndefined();
		rpcLike.enabled = true;
		expect(ui.askDialog).toBeFunction();
	});

	it("calls a dialog the context replaced after the first access", async () => {
		const calls: string[] = [];
		const replaceable = { select: async () => calls.push("first") };
		const ui = trackUserWaits(replaceable as unknown as ExtensionUIContext, dialog => dialog());
		await ui.select("a", []);
		replaceable.select = async () => calls.push("second");
		await ui.select("b", []);
		expect(calls).toEqual(["first", "second"]);
	});
});
