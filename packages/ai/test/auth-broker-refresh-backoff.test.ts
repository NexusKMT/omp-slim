import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, withAuth } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-broker-refresh-backoff";
const SOURCE = "auth-broker-refresh-backoff-test";
const TOKEN = "auth-broker-refresh-backoff-bearer";

describe("auth broker OAuth refresh backoff", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let clientStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let refreshCalls = 0;

	beforeEach(async () => {
		refreshCalls = 0;
		registerOAuthProvider({
			id: PROVIDER,
			name: "Broker Refresh Backoff Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login-access", refresh: "login-refresh", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials: OAuthCredentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: `access-${refreshCalls}`,
					refresh: `refresh-${refreshCalls}`,
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-refresh-backoff-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		await store.saveOAuth(PROVIDER, {
			access: "access-0",
			refresh: "refresh-0",
			expires: Date.now() + 60 * 60_000,
			accountId: "broker-refresh-backoff-account",
		});
		brokerStorage = new AuthStorage(store);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE);
		remote?.close();
		await handle?.close();
		clientStorage?.close();
		brokerStorage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("broker clients share outage cooldown without blocking a freshly refreshed credential", async () => {
		if (!store || !handle || !brokerStorage) throw new Error("test setup failed");
		const start = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		const firstClient = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const initial = await firstClient.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		const credentialId = initial.snapshot.credentials[0]!.id;
		await firstClient.refreshCredential(credentialId);
		expect(refreshCalls).toBe(1);

		// A separate client must reuse the broker's recent refresh, not rotate
		// the same row independently or change its snapshot generation.
		const secondClient = new AuthBrokerClient({ url: handle.url, token: TOKEN });
		const refreshedSnapshot = await secondClient.fetchSnapshot();
		if (refreshedSnapshot.status !== 200) throw new Error("expected refreshed broker snapshot");
		const redundantRefresh = await secondClient.refreshCredential(credentialId);
		expect(redundantRefresh.entry.credential).toMatchObject({ type: "oauth", access: "access-1" });
		expect(refreshCalls).toBe(1);
		expect(brokerStorage.credentials.snapshot().generation).toBe(refreshedSnapshot.snapshot.generation);

		remote = new RemoteAuthCredentialStore({
			client: secondClient,
			initialSnapshot: refreshedSnapshot.snapshot,
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.credentials.reload();
		const suspectSpy = vi.spyOn(remote, "markCredentialSuspect");
		const blockWriteSpy = vi.spyOn(remote, "upsertCredentialBlock");
		const authError = Object.assign(new Error("401 invalid_api_key"), { status: 401 });
		const generation = brokerStorage.credentials.snapshot().generation;
		for (const elapsed of [0, 60_000, 180_000, 299_999]) {
			clock.mockReturnValue(start + elapsed);
			await expect(
				withAuth(clientStorage.keys.resolver(PROVIDER, { sessionId: `outage-${elapsed}` }), async () => {
					throw authError;
				}),
			).rejects.toBe(authError);
			expect(refreshCalls).toBe(1);
			expect(suspectSpy).not.toHaveBeenCalled();
			expect(blockWriteSpy).not.toHaveBeenCalled();
			expect(store.listCredentialBlocks([credentialId])).toEqual([]);
			expect(brokerStorage.credentials.snapshot().generation).toBe(generation);
		}

		expect(await clientStorage.limits.invalidateMatching(PROVIDER, "access-1")).toBe(false);
		expect(suspectSpy).not.toHaveBeenCalled();
		expect(blockWriteSpy).not.toHaveBeenCalled();

		// Recovery is allowed at the backoff boundary, but another 401 on the
		// new bearer still must not enter the credential-block write path.
		clock.mockReturnValue(start + 300_000);
		await expect(
			withAuth(clientStorage.keys.resolver(PROVIDER), async () => {
				throw authError;
			}),
		).rejects.toBe(authError);
		expect(refreshCalls).toBe(2);
		expect(suspectSpy).not.toHaveBeenCalled();
		expect(blockWriteSpy).not.toHaveBeenCalled();
		expect(store.listCredentialBlocks([credentialId])).toEqual([]);

		await clientStorage.limits.rotate(PROVIDER, "outage", {
			credentialId,
			apiKey: "access-2",
			error: new Error("Encountered invalidated oauth token for user, failing request"),
		});
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
	});
});
