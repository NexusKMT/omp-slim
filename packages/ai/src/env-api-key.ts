/** An explicit endpoint can use its namespaced API-key variable; no vendor presets or login tokens. */
export function getEnvApiKeyName(provider: string): string | undefined {
	const name = provider.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
	return name ? `${name}_API_KEY` : undefined;
}
export function getEnvApiKey(provider: string): string | undefined {
	const name = getEnvApiKeyName(provider);
	return name ? process.env[name] || undefined : undefined;
}
