import { $env } from "@oh-my-pi/pi-utils";

/** Bundled xAI API endpoint for the `xai` and `xai-oauth` providers. */
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";

/**
 * Resolve the base URL for an xAI request.
 *
 * `XAI_BASE_URL` redirects traffic that targets the bundled default endpoint
 * (or has no base URL). A custom `baseUrl` (models.yml, provider config)
 * always wins. Trailing slashes on the override are stripped.
 */
export function resolveXaiBaseUrl(baseUrl: string | undefined): string | undefined {
	if (baseUrl && baseUrl.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL) return baseUrl;
	const override = $env.XAI_BASE_URL?.trim().replace(/\/+$/, "");
	return override || baseUrl;
}
