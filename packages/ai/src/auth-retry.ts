import * as AIError from "./error";
export interface ApiKeyResolveContext {
	error: unknown;
	lastChance: boolean;
	signal?: AbortSignal;
	previousKey?: string;
}
export interface ResolvedApiKey {
	apiKey: string;
	credentialId?: number;
}
export type ApiKeyResolution = string | ResolvedApiKey | undefined;
export type ApiKeyResolver = (context: ApiKeyResolveContext) => ApiKeyResolution | Promise<ApiKeyResolution>;
export type ApiKey = string | ApiKeyResolver;
export const NO_AUTH_SENTINEL = "N/A";
export const AUTH_RETRY_MAX_ATTEMPTS = 8;
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}
export function resolvedApiKeyBearer(value: ApiKeyResolution): string | undefined {
	return typeof value === "string" ? value : value?.apiKey;
}
export function isAuthRetryableError(error: unknown): boolean {
	return AIError.status(error) === 401 || AIError.status(error) === 403;
}
export async function resolveApiKeyOnce(
	key: ApiKey | undefined,
	signal?: AbortSignal,
	onResolved?: (value: ApiKeyResolution) => void,
): Promise<string | undefined> {
	if (!isApiKeyResolver(key)) return resolvedApiKeyBearer(key);
	signal?.throwIfAborted();
	const value = await key({ error: undefined, lastChance: false, signal });
	signal?.throwIfAborted();
	onResolved?.(value);
	return resolvedApiKeyBearer(value);
}
export function seedApiKeyResolver(seed: ApiKeyResolution, resolver: ApiKeyResolver): ApiKeyResolver {
	let pending = seed !== undefined;
	return context => {
		if (pending && context.error === undefined) {
			pending = false;
			return seed;
		}
		return resolver(context);
	};
}
export interface AuthRetryKeyState {
	attemptedKeys: Set<string>;
	lastKey: string;
	attempts: number;
}
export function createAuthRetryKeyState(key: string): AuthRetryKeyState {
	return { attemptedKeys: new Set([key]), lastKey: key, attempts: 1 };
}
export function preferAuthRetryError(_previous: unknown, next: unknown): unknown {
	return next;
}
/** An embedding host may explicitly replace a rejected key; storage itself never selects sibling accounts. */
export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
	onResolved?: (value: ApiKeyResolution) => void,
): Promise<string | undefined> {
	if (signal?.aborted || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS || !isAuthRetryableError(error)) return undefined;
	const resolved = await resolver({ error, lastChance: true, signal, previousKey: state.lastKey });
	const key = resolvedApiKeyBearer(resolved);
	if (signal?.aborted || key === undefined || state.attemptedKeys.has(key)) return undefined;
	state.attemptedKeys.add(key);
	state.lastKey = key;
	state.attempts++;
	onResolved?.(resolved);
	return key;
}
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	options?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const first = await resolveApiKeyOnce(key, options?.signal);
	if (first === undefined) throw new AIError.MissingApiKeyError(undefined, options?.missingKeyMessage);
	const state = createAuthRetryKeyState(first);
	let current = first;
	for (;;) {
		try {
			return await attempt(current);
		} catch (error) {
			if (!isApiKeyResolver(key) || !(options?.isAuthError ?? isAuthRetryableError)(error)) throw error;
			const next = await resolveNextAuthRetryKey(state, key, error, options?.signal);
			if (next === undefined) throw error;
			current = next;
		}
	}
}
