import { $env } from "@oh-my-pi/pi-utils";
import { redactSensitiveCredentials } from "./providers/transform-messages";
import type { CacheRetention } from "./types";
export { normalizeToolCallId } from "./providers/transform-messages";
export { isRecord } from "@oh-my-pi/pi-utils";
/**
 * Read a header value ignoring key casing. HTTP header names are
 * case-insensitive, but `Record<string, string>` header bags are not, so a
 * config-authored `User-Agent` and a caller-authored `user-agent` are the same
 * header to every provider that lowercases before merging.
 */
export function getHeaderCaseInsensitive(
	headers: Record<string, string> | undefined,
	headerName: string,
): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
	if (systemPrompt === undefined || systemPrompt === null) return [];
	const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
	return prompts
		.map(prompt => redactSensitiveCredentials(prompt.toWellFormed()))
		.filter(prompt => prompt.trim().length > 0);
}

export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	fallback: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) return cacheRetention;
	const env = $env.PI_CACHE_RETENTION;
	if (env === "long" || env === "short" || env === "none") return env;
	return fallback;
}
