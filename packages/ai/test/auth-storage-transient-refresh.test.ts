/**
 * A transient OAuth refresh failure (network blip, timeout) must not read as
 * "no credential configured": `MissingApiKeyError` is non-retryable, so a single
 * blip used to end an unattended session with "No API key for provider" while
 * the stored credential was still valid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;

const expiredOAuth = () => ({
	type: "oauth" as const,
	access: "expired-access",
	refresh: "refresh-1",
	expires: Date.now() - 60_000,
});

describe("AuthStorage transient OAuth refresh failure", () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let storage: AuthStorage | undefined;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		storage?.close();
		storage = undefined;
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	const open = async (): Promise<AuthStorage> => {
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"));
		return storage;
	};

	it("surfaces the refresh error instead of a missing key, keeping the credential", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth()]);
		const refresh = vi
			.spyOn(oauthUtils, "refreshOAuthToken")
			.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
			.mockResolvedValue({ access: "fresh-access", refresh: "refresh-2", expires: Date.now() + 3_600_000 });

		await expect(auth.keys.get("anthropic", "session")).rejects.toThrow("ECONNRESET");
		expect(auth.credentials.has("anthropic")).toBe(true);

		expect(await auth.keys.get("anthropic", "session")).toBe("fresh-access");
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("still falls back to a stored API key when OAuth refresh fails transiently", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth(), { type: "api_key", key: "sk-fallback" }]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNRESET"));

		expect(await auth.keys.get("anthropic", "session")).toBe("sk-fallback");
	});

	it("reports no key after a definitive refresh failure disables the only credential", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [expiredOAuth()]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(
			new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}'),
		);

		expect(await auth.keys.get("anthropic", "session")).toBeUndefined();
		expect(auth.credentials.has("anthropic")).toBe(false);
	});
});
