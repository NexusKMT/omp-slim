/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "./registry";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_AUTH_ACCOUNT_POLICIES: AuthAccountPolicies = [];

// Auth broker — credentials proxied through a remote `omp auth-broker serve`
// host. Hidden from the UI; populate via env vars or hand-edited config.yml. Env takes
// precedence so per-machine overrides remain trivial. The connection itself is resolved by
// `@oh-my-pi/pi-ai/auth-broker/discover` from env + global config.yml only (project layers
// never redirect credentials); these definitions own validation, CLI, and `cfg://` display.
export const cfgAuthBrokerUrl = register({
	id: "auth.broker.url",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_URL",
});

export const cfgAuthBrokerToken = register({
	id: "auth.broker.token",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_TOKEN",
	credential: true,
});

export const cfgAuthAccountPolicies = register({
	id: "auth.accountPolicies",
	type: "array",
	default: EMPTY_AUTH_ACCOUNT_POLICIES,
});

export const cfgEnabledModels = register({
	id: "enabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});

export const cfgEnabledProviders = register({
	id: "enabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgDisabledProviders = register({
	id: "disabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

/** The selected model, optionally followed by a thinking-level suffix. */
export const cfgModel = register({ id: "model", type: "string", default: undefined });

export const cfgModelStorage = register({
	id: "modelStorage",
	type: "enum",
	values: ["global", "project"] as const,
	default: "global",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Model Storage",
		description: "Where the selected model is saved",
		options: [
			{ value: "global", label: "Global", description: "Save the model in the active profile config" },
			{
				value: "project",
				label: "Per-project",
				description: "Save the model in .omp/config.yml; unset projects use the profile model",
			},
		],
	},
});

export const cfgModelProviderOrder = register({ id: "modelProviderOrder", type: "array", default: EMPTY_STRING_ARRAY });
