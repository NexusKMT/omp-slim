import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const loginApiKey = createApiKeyLogin({
	providerLabel: "QwenCloud Token Plan",
	authUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
	instructions:
		"Subscribe to Token Plan Individual and copy its dedicated API key. Keep this page open; the next prompt explains how to enable optional quota reporting.",
	promptMessage: "Paste your QwenCloud Token Plan API key",
	placeholder: "sk-sp-...",
	validation: {
		kind: "models-endpoint",
		provider: "QwenCloud Token Plan",
		modelsUrl: `${TOKEN_PLAN_BASE_URL}/models`,
	},
});

export async function loginAlibabaTokenPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("QwenCloud Token Plan");
	}
	const apiKey = await loginApiKey(options);
	const rawCookie = await options.onPrompt({
		message:
			"Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the cs-data.qwencloud.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.",
		placeholder: "name=value; name=value; ...",
		allowEmpty: true,
	});
	const cookie = rawCookie
		.trim()
		.replace(/^Cookie:\s*/i, "")
		.trim();
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (
		cookie &&
		!cookie.split(";").some(segment => {
			const separator = segment.indexOf("=");
			return separator > 0 && Boolean(segment.slice(0, separator).trim() && segment.slice(separator + 1).trim());
		})
	) {
		throw new AIError.ConfigurationError(
			"Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the cs-data.qwencloud.com usage request, not a single cookie value.",
		);
	}
	return serializeAlibabaTokenPlanCredential(apiKey, cookie);
}

export const alibabaTokenPlanProvider = {
	id: "alibaba-token-plan",
	name: "QwenCloud Token Plan",
	login: (cb: OAuthLoginCallbacks) => loginAlibabaTokenPlan(cb),
} as const satisfies ProviderDefinition;
