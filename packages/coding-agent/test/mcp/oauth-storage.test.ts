import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MCPOAuthStorage } from "../../src/mcp/oauth-storage";
import type { MCPStoredOAuthCredential } from "../../src/mcp/oauth-flow";

const grant: MCPStoredOAuthCredential = { type: "oauth", access: "access", refresh: "refresh", expires: 9999999999999 };

describe("MCP credential storage", () => {
	test("migrates only local MCP grants and never restores a removed grant on reopening", async () => {
		using dir = TempDir.createSync("mcp-oauth-migration-");
		const dbPath = dir.join("auth.db");
		const legacy = new Database(dbPath);
		legacy.run(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)",
		);
		const insert = legacy.query("INSERT INTO auth_credentials VALUES (?, ?, ?, ?, ?)");
		insert.run(1, "mcp_oauth:https://example.invalid/mcp", "oauth", JSON.stringify(grant), null);
		insert.run(2, "openai-codex", "oauth", JSON.stringify(grant), null);
		insert.run(3, "mcp_oauth:disabled", "oauth", JSON.stringify(grant), "revoked");
		insert.run(4, "mcp_oauth:broker", "oauth", JSON.stringify({ ...grant, refresh: "__remote__" }), null);
		insert.run(5, "mcp_oauth:bad", "oauth", "{}", null);
		legacy.close();
		const first = await MCPOAuthStorage.open(dbPath);
		expect(first.get("mcp_oauth:https://example.invalid/mcp")?.access).toBe("access");
		for (const id of ["openai-codex", "mcp_oauth:disabled", "mcp_oauth:broker", "mcp_oauth:bad"])
			expect(first.get(id)).toBeUndefined();
		await first.remove("mcp_oauth:https://example.invalid/mcp");
		first.close();
		const reopened = await MCPOAuthStorage.open(dbPath);
		expect(reopened.get("mcp_oauth:https://example.invalid/mcp")).toBeUndefined();
		reopened.close();
	});
	test("keeps a newer login when a stale refresh tries to overwrite or remove it", async () => {
		using dir = TempDir.createSync("mcp-oauth-persist-");
		const dbPath = dir.join("auth.db");
		const first = await MCPOAuthStorage.open(dbPath);
		const second = await MCPOAuthStorage.open(dbPath);
		await first.set("mcp_oauth:test", grant);
		const observed = second.get("mcp_oauth:test")!;
		await first.set("mcp_oauth:test", { ...grant, access: "new-login" });
		expect(second.replaceIfUnchanged("mcp_oauth:test", observed, { ...grant, access: "stale-refresh" })).toBe(false);
		expect(second.replaceIfUnchanged("mcp_oauth:test", observed, undefined)).toBe(false);
		first.close();
		second.close();
		const reopened = await MCPOAuthStorage.open(dbPath);
		expect(reopened.get("mcp_oauth:test")?.access).toBe("new-login");
		reopened.close();
	});
});
