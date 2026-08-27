import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { MCPStoredOAuthCredential } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

test("token refreshes and persists a rotating local MCP OAuth grant", async () => {
	using tempDir = TempDir.createSync("@omp-token-mcp-oauth-");
	const provider = "mcp_oauth:profile:default:https://mcp.example.test/MCP";
	const dbPath = tempDir.join("agent.db");
	const refreshTokens: string[] = [];
	const tokenServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = new URLSearchParams(await request.text());
			refreshTokens.push(body.get("refresh_token") ?? "");
			return Response.json({
				access_token: "access-1",
				refresh_token: "refresh-1",
				expires_in: 3600,
			});
		},
	});

	try {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const authStorage = new AuthStorage(store);
		await authStorage.reload();
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() - 60_000,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		};
		await authStorage.set(provider, credential);
		authStorage.close();

		const proc = Bun.spawn([process.execPath, cliEntry, "token", provider, "--force-refresh"], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				NO_COLOR: "1",
				OMP_AUTH_BROKER_TOKEN: undefined,
				OMP_AUTH_BROKER_URL: undefined,
				PI_CODING_AGENT_DIR: tempDir.path(),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("access-1\n");
		expect(refreshTokens).toEqual(["refresh-0"]);

		const persistedStore = await SqliteAuthCredentialStore.open(dbPath);
		const persistedStorage = new AuthStorage(persistedStore);
		await persistedStorage.reload();
		const persisted = persistedStorage.get(provider);
		expect(persisted?.type).toBe("oauth");
		if (persisted?.type === "oauth") {
			expect(persisted.access).toBe("access-1");
			expect(persisted.refresh).toBe("refresh-1");
		}
		persistedStorage.close();

		const db = new Database(dbPath, { readonly: true });
		const blockCount = db.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_credential_blocks").get();
		db.close();
		expect(blockCount?.count).toBe(0);
	} finally {
		tokenServer.stop(true);
	}
}, 30_000);
