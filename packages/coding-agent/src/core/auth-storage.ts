/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	getEnvApiKey,
	getOAuthApiKey,
	loginAnthropic,
	loginAntigravity,
	loginGeminiCli,
	loginGitHubCopilot,
	loginOpenAICodex,
	type OAuthCredentials,
	type OAuthProvider,
} from "@oh-my-pi/pi-ai";
import { logger } from "./logger";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Credential storage backed by a JSON file.
 * Reads from multiple fallback paths, writes to primary path.
 */
export class AuthStorage {
	// File locking configuration for concurrent access protection
	private static readonly lockRetryDelayMs = 50; // Polling interval when waiting for lock
	private static readonly lockTimeoutMs = 5000; // Max wait time before failing
	private static readonly lockStaleMs = 30000; // Age threshold for auto-removing orphaned locks

	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution */
	private providerRoundRobinIndex: Map<string, number> = new Map();
	/** Maps provider:type -> sessionId -> credentialIndex for session-sticky credential assignment */
	private sessionCredentialIndexes: Map<string, Map<string, number>> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;

	/**
	 * @param authPath - Primary path for reading/writing auth.json
	 * @param fallbackPaths - Additional paths to check when reading (legacy support)
	 */
	constructor(
		private authPath: string,
		private fallbackPaths: string[] = [],
	) {}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from disk.
	 * Checks primary path first, then fallback paths.
	 */
	async reload(): Promise<void> {
		const pathsToCheck = [this.authPath, ...this.fallbackPaths];

		logger.debug("AuthStorage.reload checking paths", { paths: pathsToCheck });

		for (const authPath of pathsToCheck) {
			const exists = existsSync(authPath);
			logger.debug("AuthStorage.reload path check", { path: authPath, exists });

			if (exists) {
				try {
					this.data = JSON.parse(readFileSync(authPath, "utf-8"));
					logger.debug("AuthStorage.reload loaded", { path: authPath, providers: Object.keys(this.data) });
					return;
				} catch (e) {
					logger.error("AuthStorage failed to parse auth file", { path: authPath, error: String(e) });
					// Continue to next path on parse error
				}
			}
		}

		logger.warn("AuthStorage no auth file found", { checkedPaths: pathsToCheck });
		this.data = {};
	}

	/**
	 * Save credentials to disk.
	 */
	private async save(): Promise<void> {
		const lockFd = await this.acquireLock();
		const tempPath = this.getTempPath();

		try {
			writeFileSync(tempPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
			renameSync(tempPath, this.authPath);
			chmodSync(this.authPath, 0o600);
			const dir = dirname(this.authPath);
			chmodSync(dir, 0o700);
		} finally {
			this.safeUnlink(tempPath);
			this.releaseLock(lockFd);
		}
	}

	/** Returns the lock file path (auth.json.lock) */
	private getLockPath(): string {
		return `${this.authPath}.lock`;
	}

	/** Returns a unique temp file path using pid and timestamp to avoid collisions */
	private getTempPath(): string {
		return `${this.authPath}.tmp-${process.pid}-${Date.now()}`;
	}

	/** Checks if lock file is older than lockStaleMs (orphaned by crashed process) */
	private isLockStale(lockPath: string): boolean {
		try {
			const stats = statSync(lockPath);
			return Date.now() - stats.mtimeMs > AuthStorage.lockStaleMs;
		} catch {
			return false;
		}
	}

	/**
	 * Acquires exclusive file lock using O_EXCL atomic create.
	 * Polls with exponential backoff, removes stale locks from crashed processes.
	 * @returns File descriptor for the lock (must be passed to releaseLock)
	 */
	private async acquireLock(): Promise<number> {
		const lockPath = this.getLockPath();
		const start = Date.now();
		const timeoutMs = AuthStorage.lockTimeoutMs;
		const retryDelayMs = AuthStorage.lockRetryDelayMs;

		while (true) {
			try {
				// O_EXCL fails if file exists, providing atomic lock acquisition
				return openSync(lockPath, "wx", 0o600);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code !== "EEXIST") {
					throw err;
				}
				if (this.isLockStale(lockPath)) {
					this.safeUnlink(lockPath);
					logger.warn("AuthStorage lock was stale, removing", { path: lockPath });
					continue;
				}
				if (Date.now() - start > timeoutMs) {
					throw new Error(`Timed out waiting for auth lock: ${lockPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			}
		}
	}

	/** Releases file lock by closing fd and removing lock file */
	private releaseLock(lockFd: number): void {
		const lockPath = this.getLockPath();
		try {
			closeSync(lockFd);
		} catch (error) {
			logger.warn("AuthStorage failed to close lock file", { error: String(error) });
		}
		this.safeUnlink(lockPath);
	}

	/** Removes file if it exists, ignoring ENOENT errors */
	private safeUnlink(path: string): void {
		try {
			unlinkSync(path);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") {
				logger.warn("AuthStorage failed to remove file", { path, error: String(error) });
			}
		}
	}

	/** Normalizes credential storage format: single credential becomes array of one */
	private normalizeCredentialEntry(entry: AuthCredentialEntry | undefined): AuthCredential[] {
		if (!entry) return [];
		return Array.isArray(entry) ? entry : [entry];
	}

	/** Returns all credentials for a provider as an array */
	private getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.normalizeCredentialEntry(this.data[provider]);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	private getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	private getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * Selects credential index with session affinity.
	 * Sessions reuse their assigned credential; new sessions get next round-robin index.
	 * This ensures a session always uses the same credential for consistency.
	 */
	private selectCredentialIndex(providerKey: string, sessionId: string | undefined, total: number): number {
		if (total <= 1) return 0;
		if (!sessionId) return 0;

		const sessionMap = this.sessionCredentialIndexes.get(providerKey);
		const existing = sessionMap?.get(sessionId);
		if (existing !== undefined && existing < total) {
			return existing;
		}

		// New session: assign next round-robin credential and cache the assignment
		const next = this.getNextRoundRobinIndex(providerKey, total);
		const updatedSessionMap = sessionMap ?? new Map<string, number>();
		updatedSessionMap.set(sessionId, next);
		this.sessionCredentialIndexes.set(providerKey, updatedSessionMap);
		return next;
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses session-sticky selection when multiple credentials exist.
	 */
	private selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } =>
					entry.credential.type === type,
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.getProviderTypeKey(provider, type);
		const selectedIndex = this.selectCredentialIndex(providerKey, sessionId, credentials.length);
		return credentials[selectedIndex];
	}

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	private resetProviderAssignments(provider: string): void {
		for (const key of this.providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.providerRoundRobinIndex.delete(key);
			}
		}
		for (const key of this.sessionCredentialIndexes.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.sessionCredentialIndexes.delete(key);
			}
		}
	}

	/** Updates credential at index in-place (used for OAuth token refresh) */
	private replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entry = this.data[provider];
		if (!entry) return;

		if (Array.isArray(entry)) {
			if (index >= 0 && index < entry.length) {
				const updated = [...entry];
				updated[index] = credential;
				this.data[provider] = updated;
			}
			return;
		}

		if (index === 0) {
			this.data[provider] = credential;
		}
	}

	/**
	 * Removes credential at index (used when OAuth refresh fails).
	 * Cleans up provider entry if last credential removed.
	 */
	private removeCredentialAt(provider: string, index: number): void {
		const entry = this.data[provider];
		if (!entry) return;

		if (Array.isArray(entry)) {
			const updated = entry.filter((_value, idx) => idx !== index);
			if (updated.length > 0) {
				this.data[provider] = updated;
			} else {
				delete this.data[provider];
			}
		} else {
			delete this.data[provider];
		}

		this.resetProviderAssignments(provider);
	}

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		this.data[provider] = credential;
		this.resetProviderAssignments(provider);
		await this.save();
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		delete this.data[provider];
		this.resetProviderAssignments(provider);
		await this.save();
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return this.getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.getCredentialsForProvider(provider).some((credential) => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	/**
	 * Get all credentials.
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProvider,
		callbacks: {
			onAuth: (info: { url: string; instructions?: string }) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			onProgress?: (message: string) => void;
			/** For providers with local callback servers (e.g., openai-codex), races with browser callback */
			onManualCodeInput?: () => Promise<string>;
			/** For cancellation support (e.g., github-copilot polling) */
			signal?: AbortSignal;
		},
	): Promise<void> {
		let credentials: OAuthCredentials;

		switch (provider) {
			case "anthropic":
				credentials = await loginAnthropic(
					(url) => callbacks.onAuth({ url }),
					() => callbacks.onPrompt({ message: "Paste the authorization code:" }),
				);
				break;
			case "github-copilot":
				credentials = await loginGitHubCopilot({
					onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
					signal: callbacks.signal,
				});
				break;
			case "google-gemini-cli":
				credentials = await loginGeminiCli(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
				break;
			case "google-antigravity":
				credentials = await loginAntigravity(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
				break;
			case "openai-codex":
				credentials = await loginOpenAICodex({
					onAuth: callbacks.onAuth,
					onPrompt: callbacks.onPrompt,
					onProgress: callbacks.onProgress,
					onManualCodeInput: callbacks.onManualCodeInput,
				});
				break;
			default:
				throw new Error(`Unknown OAuth provider: ${provider}`);
		}

		const newCredential: OAuthCredential = { type: "oauth", ...credentials };
		const existing = this.getCredentialsForProvider(provider);
		if (existing.length === 0) {
			await this.set(provider, newCredential);
			return;
		}

		await this.set(provider, [...existing, newCredential]);
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(provider: string, sessionId?: string): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const apiKeySelection = this.selectCredentialByType(provider, "api_key", sessionId);
		if (apiKeySelection) {
			return apiKeySelection.credential.key;
		}

		const oauthSelection = this.selectCredentialByType(provider, "oauth", sessionId);
		if (oauthSelection) {
			const oauthCreds: Record<string, OAuthCredentials> = {
				[provider]: oauthSelection.credential,
			};

			try {
				const result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
				if (result) {
					this.replaceCredentialAt(provider, oauthSelection.index, { type: "oauth", ...result.newCredentials });
					await this.save();
					return result.apiKey;
				}
			} catch {
				this.removeCredentialAt(provider, oauthSelection.index);
				await this.save();
				if (this.getCredentialsForProvider(provider).some((credential) => credential.type === "oauth")) {
					return this.getApiKey(provider, sessionId);
				}
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.fallbackResolver?.(provider) ?? undefined;
	}
}
