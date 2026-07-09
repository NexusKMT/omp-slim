import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import { loginXAIOAuth, refreshXAIOAuthToken } from "./oauth/xai-oauth";
import type { ProviderDefinition } from "./types";

export const xaiOauthProvider = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok or X Premium+)",
	login: (cb: OAuthLoginCallbacks) => loginXAIOAuth(cb),
	refreshToken: (credentials: OAuthCredentials) => refreshXAIOAuthToken(credentials.refresh),
} as const satisfies ProviderDefinition;
