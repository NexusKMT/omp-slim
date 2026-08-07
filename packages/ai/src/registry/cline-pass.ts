import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginClinePass = createApiKeyLogin({
	providerLabel: "ClinePass",
	authUrl: "https://app.cline.bot/dashboard/account",
	instructions: "Create an API key in the Cline dashboard under Settings → API Keys",
	promptMessage: "Paste your Cline API key",
	placeholder: "sk_...",
	validation: {
		kind: "chat-completions",
		provider: "ClinePass",
		baseUrl: "https://api.cline.bot/api/v1",
		model: "cline-pass/kimi-k3",
		maxTokensField: "max_completion_tokens",
		maxTokens: 16,
	},
});

export const clinePassProvider = {
	id: "cline-pass",
	name: "ClinePass",
	login: (callbacks: OAuthLoginCallbacks) => loginClinePass(callbacks),
} as const satisfies ProviderDefinition;
