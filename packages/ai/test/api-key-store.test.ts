import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("generic API-key storage", () => {
	it("persists, reloads, and removes API keys", async () => {
		using dir = TempDir.createSync("omp-chat-auth-");
		const file = dir.join("auth.db");
		const auth = await AuthStorage.create(file);
		await auth.credentials.set("gateway", { type: "api_key", key: "stored-key" });
		const id = auth.credentials.list("gateway")[0]!.id;
		auth.close();
		const reopened = await AuthStorage.create(file);
		try {
			expect(await reopened.keys.getWithCredential("gateway")).toEqual({ apiKey: "stored-key", credentialId: id });
			expect(await reopened.credentials.removeById("other", id)).toBe(false);
			expect(await reopened.credentials.removeById("gateway", id)).toBe(true);
			expect(await reopened.keys.get("gateway")).toBeUndefined();
		} finally {
			reopened.close();
		}
	});
	it("uses runtime then configuration then environment then stored keys", async () => {
		const previous = process.env.OMP_CHAT_FIXTURE_API_KEY;
		process.env.OMP_CHAT_FIXTURE_API_KEY = "environment-key";
		const auth = await AuthStorage.create(":memory:");
		try {
			await auth.credentials.set("omp-chat-fixture", { type: "api_key", key: "stored-key" });
			auth.keys.setResolver(async value => (value === "configured-ref" ? "configuration-key" : value));
			auth.keys.setConfig("omp-chat-fixture", "configured-ref");
			auth.keys.setRuntime("omp-chat-fixture", "runtime-key");
			expect(await auth.keys.get("omp-chat-fixture")).toBe("runtime-key");
			auth.keys.removeRuntime("omp-chat-fixture");
			expect(await auth.keys.get("omp-chat-fixture")).toBe("configuration-key");
			auth.keys.clearConfig();
			expect(await auth.keys.get("omp-chat-fixture")).toBe("environment-key");
			delete process.env.OMP_CHAT_FIXTURE_API_KEY;
			expect(await auth.keys.get("omp-chat-fixture")).toBe("stored-key");
		} finally {
			auth.close();
			if (previous === undefined) delete process.env.OMP_CHAT_FIXTURE_API_KEY;
			else process.env.OMP_CHAT_FIXTURE_API_KEY = previous;
		}
	});
	it("ignores legacy OAuth rows and rejects new non-key credentials", async () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
			"gateway",
			"oauth",
			JSON.stringify({ type: "oauth", access: "retired-token" }),
		);
		const auth = new AuthStorage(store);
		try {
			expect(auth.credentials.list()).toEqual([]);
			expect(await auth.keys.get("gateway")).toBeUndefined();
			const legacy = JSON.parse('{"type":"oauth","access":"retired-token"}');
			await expect(auth.credentials.set("gateway", legacy)).rejects.toThrow("Only API-key credentials");
		} finally {
			auth.close();
		}
	});
	it("honors cancellation while a configured key resolves", async () => {
		const auth = await AuthStorage.create(":memory:");
		const pending = Promise.withResolvers<string>();
		auth.keys.setConfig("gateway", "key-ref");
		auth.keys.setResolver(() => pending.promise);
		const abort = new AbortController();
		try {
			const key = auth.keys.get("gateway", undefined, { signal: abort.signal });
			abort.abort(new Error("cancel key resolution"));
			await expect(key).rejects.toThrow("cancel key resolution");
		} finally {
			pending.resolve("unused");
			auth.close();
		}
	});
	it("notifies changes after persisted writes and does not rotate keys on errors", async () => {
		const auth = await AuthStorage.create(":memory:");
		const generations: number[] = [];
		auth.credentials.onGeneration(value => generations.push(value));
		try {
			await auth.credentials.set("gateway", [
				{ type: "api_key", key: "first" },
				{ type: "api_key", key: "second" },
			]);
			const resolver = auth.keys.resolver("gateway");
			expect(await resolver({ error: undefined, lastChance: false })).toMatchObject({ apiKey: "first" });
			expect(await resolver({ error: new Error("401"), lastChance: true })).toBeUndefined();
			expect(generations).toEqual([1]);
		} finally {
			auth.close();
		}
	});
});
