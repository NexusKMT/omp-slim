import type { ApiKeyResolver, ResolvedApiKey } from "../auth-retry";
export type ApiKeyCredential = { type: "api_key"; key: string; source?: "login" };
export type AuthCredential = ApiKeyCredential;
export type AuthCredentialEntry = AuthCredential | AuthCredential[];
export type AuthStorageData = Record<string, AuthCredentialEntry>;
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}
export type CredentialOriginKind = "runtime" | "config" | "api_key" | "env";
export interface CredentialOrigin {
	kind: CredentialOriginKind;
	envVar?: string;
}
export interface AuthSource extends CredentialOrigin {
	credentialId?: number;
}
export interface AuthApiKeyOptions {
	modelId?: string;
	baseUrl?: string;
	signal?: AbortSignal;
}
export interface AuthSourceOptions {
	sessionId?: string;
}
export interface AuthPeekOptions {
	baseUrl?: string;
}
export interface AuthStorageOptions {
	configValueResolver?: (config: string) => Promise<string | undefined>;
	sourceLabel?: string;
}
export interface CredentialsApi {
	readonly generation: number;
	onGeneration(listener: (generation: number) => void): () => void;
	reload(): Promise<void>;
	poll(): Promise<boolean>;
	get(provider: string): AuthCredential | undefined;
	all(): AuthStorageData;
	list(provider?: string): StoredAuthCredential[];
	has(provider: string): boolean;
	set(provider: string, credential: AuthCredentialEntry): Promise<void>;
	upsert(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	remove(provider: string): Promise<void>;
	removeById(provider: string, id: number): Promise<boolean>;
}
export interface KeysApi {
	get(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
	getWithCredential(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<ResolvedApiKey | undefined>;
	has(provider: string): Promise<boolean>;
	peek(provider: string, options?: AuthPeekOptions): Promise<string | undefined>;
	source(provider: string, options?: AuthSourceOptions): AuthSource | undefined;
	describe(provider: string, sessionId?: string): string | undefined;
	setRuntime(provider: string, apiKey: string): void;
	removeRuntime(provider: string): void;
	setConfig(provider: string, config: string, options?: { fallback?: boolean }): void;
	removeConfig(provider: string): void;
	clearConfig(): void;
	setResolver(resolver: (config: string) => Promise<string | undefined>): void;
	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver;
}
