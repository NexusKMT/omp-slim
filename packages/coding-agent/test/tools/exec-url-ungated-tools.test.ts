import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { execUrlProtocol } from "../helpers/exec-url-protocol";

beforeEach(() => {
	InternalUrlRouter.instance().register(execUrlProtocol);
});

afterEach(() => {
	InternalUrlRouter.instance().unregister(execUrlProtocol.scheme);
});

// A read/write-tier filesystem must reject exec-tier schemes before invoking
// a handler that can run an external command or access a remote resource.
describe("execfs:// is rejected before resolving the resource in read/write-tier tools", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolveToolSearchScope (ast_grep + ast_edit) throws on execfs:// without resolving", async () => {
		// Reject if resolve is ever reached, so a guard regression fails loudly
		// instead of attempting a real connection.
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for execfs://"));
		await expect(
			resolveToolSearchScope({
				rawPaths: ["execfs://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "search",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
			}),
		).rejects.toThrow("Cannot search execfs://h/x: execfs:// access needs exec approval");
		await expect(
			resolveToolSearchScope({
				rawPaths: ["execfs://h/x"],
				cwd: os.tmpdir(),
				internalUrlAction: "rewrite",
				filesystem: new InternalUrlFilesystem({ context: {}, tier: "write" }),
				fileWritableOnly: true,
			}),
		).rejects.toThrow("Cannot rewrite execfs://h/x: execfs:// URLs are not editable files");
		expect(spy).not.toHaveBeenCalled();
	});
});
