import { describe, expect, it } from "bun:test";
import { canonicalizeMCPToolName, createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { resolveMountedXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools/index";

// `createMCPToolName` joins the sanitized server and tool with a SINGLE
// underscore, but the harness identifies itself to the model as Claude Code,
// whose convention is `mcp__<server>__<tool>`. A primed model therefore emits
// the doubled separator — frequently keeping the raw, unsanitized server
// spelling too (`mcp__seedpatch-client__bank`) — and strict exact-match
// dispatch answered every one of those with `Tool ... not found` for a tool the
// session really does expose.
//
// `canonicalizeMCPToolName` closes that gap by re-running the minting sanitizer
// over the emitted suffix. These tests pin the two properties that make it a
// normalization rather than a guess: it reproduces the real registry key for
// each spelling a model actually emits, and it never collapses two distinct
// registry keys together.

describe("canonicalizeMCPToolName", () => {
	it("recovers the registry key from the Claude Code separator", () => {
		const registered = createMCPToolName("seedpatch-client", "bank");
		expect(registered).toBe("mcp__seedpatch_client_bank");

		// Raw hyphenated server name + doubled separator: what a Claude
		// Code-primed model emits for a server literally named `seedpatch-client`.
		expect(canonicalizeMCPToolName("mcp__seedpatch-client__bank")).toBe(registered);
		// Sanitized server name + doubled separator.
		expect(canonicalizeMCPToolName("mcp__seedpatch_client__bank")).toBe(registered);
	});

	it("recovers multi-word tool names", () => {
		const registered = createMCPToolName("osrs-wiki", "search_cache");
		expect(canonicalizeMCPToolName("mcp__osrs-wiki__search_cache")).toBe(registered);
		expect(canonicalizeMCPToolName("mcp__osrs_wiki__search_cache")).toBe(registered);
	});

	it("recovers a name whose server segment carries digits", () => {
		// Reported shape: the sanitizer maps `[^a-z_]+` to `_`, so the digit in
		// `context7` is dropped when the name is minted. The emitted
		// double-underscore spelling must still land on that key.
		const registered = createMCPToolName("context7", "resolve-library-id");
		expect(registered).toBe("mcp__context_resolve_library_id");
		expect(canonicalizeMCPToolName("mcp__context7__resolve_library_id")).toBe(registered);
	});

	it("leaves an already-canonical name alone so exact match stays authoritative", () => {
		// Returning `undefined` is what keeps this off the hot path: a registered
		// name is found by direct lookup and never reaches canonicalization.
		expect(canonicalizeMCPToolName(createMCPToolName("seedpatch-client", "bank"))).toBeUndefined();
		expect(canonicalizeMCPToolName(createMCPToolName("osrs-wiki", "search_cache"))).toBeUndefined();
	});

	it("never routes a non-MCP name", () => {
		// The registry holds first-party tools under bare names; canonicalization
		// must not offer a path to them from a hallucinated call.
		expect(canonicalizeMCPToolName("read")).toBeUndefined();
		expect(canonicalizeMCPToolName("edit")).toBeUndefined();
		expect(canonicalizeMCPToolName("mcp__")).toBeUndefined();
	});

	it("keeps servers distinct whose sanitized names prefix-collide", () => {
		// `atlassian` vs `atlassian:atlassian` is the documented lossy-sanitization
		// hazard: a fuzzy matcher would conflate them. Each Claude Code spelling
		// must reach its own server's key and nothing else.
		const short = createMCPToolName("atlassian", "get_issue");
		const colon = createMCPToolName("atlassian:atlassian", "get_issue");
		expect(short).not.toBe(colon);

		expect(canonicalizeMCPToolName("mcp__atlassian__get_issue")).toBe(short);
		expect(canonicalizeMCPToolName("mcp__atlassian:atlassian__get_issue")).toBe(colon);
	});
});

/** Minimal mounted-device state: the fields `resolveMountedXdevTool` reads. */
function xdevStateWith(names: string[]): XdevState {
	const tools = new Map<string, Tool>();
	for (const name of names) tools.set(name, { name } as Tool);
	return {
		tools,
		mountedNames: new Set(names),
		builtInNames: new Set(),
		isActive: () => false,
	};
}

describe("resolveMountedXdevTool", () => {
	it("routes the Claude Code spelling of a mounted MCP device", () => {
		// With many MCP tools the session presents them as `xd://` devices, so
		// this is the dispatch path a real session hits. Both the direct call and
		// the `xd://`-prefixed write spelling must resolve.
		const registered = createMCPToolName("seedpatch-client", "bank");
		const state = xdevStateWith([registered, "github"]);

		expect(resolveMountedXdevTool(state, "mcp__seedpatch-client__bank")?.name).toBe(registered);
		expect(resolveMountedXdevTool(state, "xd://mcp__seedpatch-client__bank")?.name).toBe(registered);
		// Exact and bare spellings keep working.
		expect(resolveMountedXdevTool(state, registered)?.name).toBe(registered);
		expect(resolveMountedXdevTool(state, "github")?.name).toBe("github");
	});

	it("still refuses a name no mounted device claims", () => {
		const state = xdevStateWith([createMCPToolName("seedpatch-client", "bank")]);
		expect(resolveMountedXdevTool(state, "mcp__other__bank")).toBeUndefined();
		expect(resolveMountedXdevTool(state, "read")).toBeUndefined();
	});
});
