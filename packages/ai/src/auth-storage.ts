import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ResolvedApiKey } from "./auth-retry";
import { getEnvApiKey, getEnvApiKeyName } from "./env-api-key";
import { SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
import type { AuthCredentialStore } from "./auth/store";
import type {
	AuthCredential,
	AuthSource,
	AuthStorageData,
	AuthStorageOptions,
	CredentialsApi,
	KeysApi,
	StoredAuthCredential,
} from "./auth/types";
export * from "./auth/store";
export * from "./auth/types";
export * from "./auth/sqlite-credential-store";
export interface AuthStorageBackend {
	readonly credentials: CredentialsApi;
	readonly keys: KeysApi;
	close(): void;
}
/** Generic API-key storage. Authentication is supplied by the configured endpoint. */
export class AuthStorage {
	readonly #backend: AuthStorageBackend;
	constructor(source: AuthCredentialStore | AuthStorageBackend, options: AuthStorageOptions = {}) {
		this.#backend = "credentials" in source ? source : new LocalAuthStorage(source, options);
	}
	get credentials(): CredentialsApi {
		return this.#backend.credentials;
	}
	get keys(): KeysApi {
		return this.#backend.keys;
	}
	static async create(dbPath: string, options?: AuthStorageOptions): Promise<AuthStorage> {
		return new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), options);
	}
	getApiKey(provider: string, sessionId?: string): Promise<string | undefined> {
		return this.keys.get(provider, sessionId);
	}
	reload(): Promise<void> {
		return this.credentials.reload();
	}
	close(): void {
		this.#backend.close();
	}
}
class LocalAuthStorage implements AuthStorageBackend {
	readonly credentials: CredentialsApi;
	readonly keys: KeysApi;
	readonly #store: AuthCredentialStore;
	#rows: StoredAuthCredential[] = [];
	#generation = 0;
	readonly #listeners = new Set<(generation: number) => void>();
	readonly #runtime = new Map<string, string>();
	readonly #config = new Map<string, { value: string; fallback: boolean }>();
	#resolveConfig: (config: string) => Promise<string | undefined>;
	constructor(store: AuthCredentialStore, options: AuthStorageOptions) {
		this.#store = store;
		this.#rows = store.listAuthCredentials();
		this.#resolveConfig = options.configValueResolver ?? (async value => process.env[value] ?? value);
		const host = this;
		this.credentials = {
			get generation() {
				return host.#generation;
			},
			onGeneration: listener => {
				this.#listeners.add(listener);
				return () => {
					this.#listeners.delete(listener);
				};
			},
			reload: async () => {
				this.#rows = this.#store.listAuthCredentials();
				this.#changed();
			},
			poll: async () => {
				if (!this.#store.pollExternalChanges?.()) return false;
				await this.credentials.reload();
				return true;
			},
			get: provider => this.credentials.list(provider)[0]?.credential,
			all: () => {
				const result: AuthStorageData = {};
				for (const row of this.#rows) {
					const previous = result[row.provider];
					result[row.provider] = previous
						? [...(Array.isArray(previous) ? previous : [previous]), row.credential]
						: row.credential;
				}
				return result;
			},
			list: provider =>
				this.#rows
					.filter(row => provider === undefined || row.provider === provider)
					.map(row => ({ ...row, credential: { ...row.credential } })),
			has: provider => this.#rows.some(row => row.provider === provider),
			set: async (provider, credential) => {
				await this.#store.replaceAuthCredentials(provider, Array.isArray(credential) ? credential : [credential]);
				await this.#reload();
			},
			upsert: async (provider, credential) => {
				await this.#store.upsertAuthCredential(provider, credential);
				await this.#reload();
				return this.credentials.list(provider);
			},
			remove: async provider => {
				await this.#store.deleteAuthCredentials(provider, "removed");
				await this.#reload();
			},
			removeById: async (provider, id) => {
				if (!this.#rows.some(row => row.id === id && row.provider === provider)) return false;
				const removed = await this.#store.deleteAuthCredential(id, "removed");
				if (removed) await this.#reload();
				return removed;
			},
		};
		this.keys = {
			get: async (provider, _sessionId, options) =>
				(await untilAborted(options?.signal, () => this.#resolve(provider)))?.apiKey,
			getWithCredential: (provider, _sessionId, options) =>
				untilAborted(options?.signal, () => this.#resolve(provider)),
			has: async provider => (await this.keys.get(provider)) !== undefined,
			peek: provider => this.keys.get(provider),
			source: provider => this.#source(provider),
			describe: provider => {
				const source = this.#source(provider);
				return source
					? source.kind === "env"
						? `environment ${source.envVar}`
						: source.kind === "api_key"
							? `stored API key #${source.credentialId}`
							: `${source.kind} API key`
					: undefined;
			},
			setRuntime: (provider, apiKey) => {
				this.#runtime.set(provider, apiKey);
			},
			removeRuntime: provider => {
				this.#runtime.delete(provider);
			},
			setConfig: (provider, value, configOptions) => {
				this.#config.set(provider, { value, fallback: configOptions?.fallback === true });
			},
			removeConfig: provider => {
				this.#config.delete(provider);
			},
			clearConfig: () => {
				this.#config.clear();
			},
			setResolver: resolver => {
				this.#resolveConfig = resolver;
			},
			resolver: (provider, resolverOptions) => context =>
				context.error === undefined
					? this.keys.getWithCredential(provider, resolverOptions?.sessionId, {
							...resolverOptions,
							signal: context.signal,
						})
					: undefined,
		};
	}
	#changed(): void {
		this.#generation++;
		for (const listener of this.#listeners) {
			try {
				listener(this.#generation);
			} catch {
				/* Observers cannot block persistence. */
			}
		}
	}
	async #reload(): Promise<void> {
		this.#store.acknowledgeLocalChanges?.();
		await this.credentials.reload();
	}
	#source(provider: string): AuthSource | undefined {
		if (this.#runtime.has(provider)) return { kind: "runtime" };
		const config = this.#config.get(provider);
		if (config && !config.fallback) return { kind: "config" };
		if (getEnvApiKey(provider)) return { kind: "env", envVar: getEnvApiKeyName(provider) };
		const row = this.#rows.find(row => row.provider === provider);
		if (row) return { kind: "api_key", credentialId: row.id };
		return config ? { kind: "config" } : undefined;
	}
	async #resolve(provider: string): Promise<ResolvedApiKey | undefined> {
		const runtime = this.#runtime.get(provider);
		if (runtime !== undefined) return { apiKey: runtime };
		const config = this.#config.get(provider);
		if (config && !config.fallback) {
			const apiKey = await this.#resolveConfig(config.value);
			if (apiKey !== undefined) return { apiKey };
		}
		const env = getEnvApiKey(provider);
		if (env !== undefined) return { apiKey: env };
		for (const row of this.#rows)
			if (row.provider === provider) {
				const apiKey = await this.#resolveConfig(row.credential.key);
				if (apiKey !== undefined) return { apiKey, credentialId: row.id };
			}
		if (config?.fallback) {
			const apiKey = await this.#resolveConfig(config.value);
			if (apiKey !== undefined) return { apiKey };
		}
		return undefined;
	}
	close(): void {
		this.#store.close();
	}
}
