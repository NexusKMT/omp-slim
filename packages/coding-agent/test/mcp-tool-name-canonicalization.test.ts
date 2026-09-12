import { describe, expect, it } from "bun:test";
import { canonicalMCPToolNameCandidates, createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { resolveFallbackXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools/index";

// `createMCPToolName` joins the sanitized server and tool with a SINGLE
// underscore, but the harness identifies itself to the model as Claude Code,
// whose convention is `mcp__<server>__<tool>`. A primed model therefore emits
// the doubled separator — frequently keeping the raw, unsanitized server
// spelling too (`mcp__seedpatch-client__bank`) — and strict exact-match
// dispatch answered every one of those with `Tool ... not found` for a tool the
// session really does expose.
//
// Every expectation below is asserted against the key `createMCPToolName`
// actually mints, so these tests cannot drift from the minting rule they are
// recovering.

describe("canonicalMCPToolNameCandidates", () => {
	/** First candidate that the registry would accept, for a one-tool registry. */
	const recover = (emitted: string, registered: string): string | undefined =>
		canonicalMCPToolNameCandidates(emitted).find(candidate => candidate === registered);

	it("recovers the registry key from the Claude Code separator", () => {
		const registered = createMCPToolName("seedpatch-client", "bank");
		expect(registered).toBe("mcp__seedpatch_client_bank");

		// Raw hyphenated server name + doubled separator: what a Claude
		// Code-primed model emits for a server literally named `seedpatch-client`.
		expect(recover("mcp__seedpatch-client__bank", registered)).toBe(registered);
		// Sanitized server name + doubled separator.
		expect(recover("mcp__seedpatch_client__bank", registered)).toBe(registered);
		// Single separator whose punctuation still differs from the minted key.
		expect(recover("mcp__seedpatch-client_bank", registered)).toBe(registered);
	});

	it("recovers multi-word tool names", () => {
		const registered = createMCPToolName("osrs-wiki", "search_cache");
		expect(recover("mcp__osrs-wiki__search_cache", registered)).toBe(registered);
		expect(recover("mcp__osrs_wiki__search_cache", registered)).toBe(registered);
	});

	it("recovers a name whose server segment carries digits", () => {
		// The sanitizer maps `[^a-z_]+` to `_`, so the digit in `context7` is
		// dropped when the name is minted. The doubled spelling must still land.
		const registered = createMCPToolName("context7", "resolve-library-id");
		expect(registered).toBe("mcp__context_resolve_library_id");
		expect(recover("mcp__context7__resolve_library_id", registered)).toBe(registered);
	});

	it("recovers a tool whose name repeats the server prefix", () => {
		// `createMCPToolName` strips the redundant prefix, so server `puppeteer`
		// with tool `puppeteer_screenshot` registers as `mcp__puppeteer_screenshot`.
		// Re-minting the split halves reproduces that; merely sanitizing the whole
		// suffix would yield the nonexistent `mcp__puppeteer_puppeteer_screenshot`.
		const registered = createMCPToolName("puppeteer", "puppeteer_screenshot");
		expect(registered).toBe("mcp__puppeteer_screenshot");
		expect(recover("mcp__puppeteer__puppeteer_screenshot", registered)).toBe(registered);
	});

	it("recovers when the raw server name itself contains a doubled separator", () => {
		// A *sanitized* server segment can never contain `__`, but the model emits
		// the raw name, which can. Splitting only at the first occurrence would
		// put the boundary inside the server and miss the key entirely.
		const registered = createMCPToolName("foo__bar", "foo_bar_baz");
		expect(registered).toBe("mcp__foo_bar_baz");
		expect(recover("mcp__foo__bar__foo_bar_baz", registered)).toBe(registered);

		// The common case must still rank first: with no `__` in the server name
		// the earliest boundary is the right one.
		const plain = createMCPToolName("seedpatch-client", "bank");
		expect(canonicalMCPToolNameCandidates("mcp__seedpatch-client__bank")[0]).toBe(plain);
	});

	it("recovers a name long enough to be hash-capped", () => {
		// Over 64 chars the minted key keeps a readable prefix plus a hash, so a
		// candidate built without the cap could never match it.
		const longTool = "a_very_long_tool_name_that_definitely_overflows_the_sixty_four_char_cap";
		const registered = createMCPToolName("srv", longTool);
		expect(registered.length).toBe(64);
		expect(recover(`mcp__srv__${longTool}`, registered)).toBe(registered);

		// Single-separator spelling of the same overlong tool: there is no
		// boundary to re-mint from, so this candidate needs the cap applied
		// directly or it can never match the hashed key either.
		const hyphenated = createMCPToolName("seedpatch-client", longTool);
		expect(hyphenated.length).toBe(64);
		expect(recover(`mcp__seedpatch-client_${longTool}`, hyphenated)).toBe(hyphenated);
	});

	it("yields nothing for an already-canonical name so exact match stays authoritative", () => {
		// An empty candidate list is what keeps this off the hot path: a registered
		// name is found by direct lookup and never reaches canonicalization.
		expect(canonicalMCPToolNameCandidates(createMCPToolName("seedpatch-client", "bank"))).toEqual([]);
		expect(canonicalMCPToolNameCandidates(createMCPToolName("osrs-wiki", "search_cache"))).toEqual([]);
		expect(canonicalMCPToolNameCandidates(createMCPToolName("puppeteer", "puppeteer_screenshot"))).toEqual([]);
	});

	it("never routes a non-MCP name", () => {
		// The registry holds first-party tools under bare names; canonicalization
		// must not offer a path to them from a hallucinated call.
		expect(canonicalMCPToolNameCandidates("read")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("edit")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("mcp__")).toEqual([]);
	});

	it("never invents a name from a degenerate segment", () => {
		// The sanitizer substitutes `server`/`tool` placeholders for an empty
		// part, so splitting blindly would mint keys nobody registered.
		for (const emitted of ["mcp____bank", "mcp__srv__", "mcp____", "mcp__-__bank", "mcp__srv__-", "mcp__--"]) {
			for (const candidate of canonicalMCPToolNameCandidates(emitted)) {
				expect(candidate).not.toContain("_server_");
				expect(candidate.endsWith("_tool")).toBe(false);
			}
		}
	});

	it("keeps servers distinct whose sanitized names prefix-collide", () => {
		// `atlassian` vs `atlassian:atlassian` is the documented lossy-sanitization
		// hazard: a fuzzy matcher would conflate them. Each Claude Code spelling
		// must reach its own server's key and nothing else.
		const short = createMCPToolName("atlassian", "get_issue");
		const colon = createMCPToolName("atlassian:atlassian", "get_issue");
		expect(short).not.toBe(colon);

		expect(canonicalMCPToolNameCandidates("mcp__atlassian__get_issue")).not.toContain(colon);
		expect(recover("mcp__atlassian__get_issue", short)).toBe(short);
		expect(recover("mcp__atlassian:atlassian__get_issue", colon)).toBe(colon);
	});
});

/** Minimal state exposing the fields `resolveFallbackXdevTool` reads. */
function xdevStateWith(options: { mounted?: string[]; active?: string[] }): XdevState {
	const mounted = options.mounted ?? [];
	const active = options.active ?? [];
	const tools = new Map<string, Tool>();
	for (const name of [...mounted, ...active]) tools.set(name, { name } as Tool);
	return {
		tools,
		mountedNames: new Set(mounted),
		builtInNames: new Set(),
		isActive: name => active.includes(name),
	};
}

describe("resolveFallbackXdevTool", () => {
	it("routes the Claude Code spelling of a mounted MCP device", () => {
		// With many MCP tools the session presents them as `xd://` devices, so
		// this is the dispatch path such a session hits.
		const registered = createMCPToolName("seedpatch-client", "bank");
		const state = xdevStateWith({ mounted: [registered, "github"] });

		expect(resolveFallbackXdevTool(state, "mcp__seedpatch-client__bank")?.name).toBe(registered);
		expect(resolveFallbackXdevTool(state, "xd://mcp__seedpatch-client__bank")?.name).toBe(registered);
		// Exact and bare spellings keep working.
		expect(resolveFallbackXdevTool(state, registered)?.name).toBe(registered);
		expect(resolveFallbackXdevTool(state, "github")?.name).toBe("github");
	});

	it("routes the Claude Code spelling of an ACTIVE top-level MCP tool", () => {
		// With `tools.xdev` off — or for an explicitly requested MCP tool — the
		// tool stays top-level and never enters `mountedNames`. The exact name is
		// matched by the advertised set, but the misspelled call reaches the
		// fallback, which previously only accepted mounted names.
		const registered = createMCPToolName("seedpatch-client", "bank");
		const state = xdevStateWith({ active: [registered] });

		expect(state.mountedNames.size).toBe(0);
		expect(resolveFallbackXdevTool(state, "mcp__seedpatch-client__bank")?.name).toBe(registered);
		expect(resolveFallbackXdevTool(state, "mcp__seedpatch_client__bank")?.name).toBe(registered);
	});

	it("never routes an active first-party tool through the fallback", () => {
		// The fallback runs for ANY call the advertised set does not contain, so
		// routing `edit` here would execute a tool the model was never offered.
		// Only `mcp__` names produce candidates, which is what forbids that.
		const state = xdevStateWith({ active: ["edit", "read"], mounted: ["github"] });
		expect(resolveFallbackXdevTool(state, "edit")).toBeUndefined();
		expect(resolveFallbackXdevTool(state, "read")).toBeUndefined();
	});

	it("still refuses a name no mounted or active tool claims", () => {
		const state = xdevStateWith({ mounted: [createMCPToolName("seedpatch-client", "bank")] });
		expect(resolveFallbackXdevTool(state, "mcp__other__bank")).toBeUndefined();
		expect(resolveFallbackXdevTool(state, "mcp__seedpatch-client__nonexistent")).toBeUndefined();
		expect(resolveFallbackXdevTool(state, "read")).toBeUndefined();
	});
});
