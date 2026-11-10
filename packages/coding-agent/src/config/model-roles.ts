/** Legacy default-model selectors accepted while old sessions and extensions migrate. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";
export const DEFAULT_MODEL_ROLE_ALIAS = "*";
export const MODEL_ROLE_IDS = ["default"] as const;
export const CHAT_MODEL_ROLE_IDS = MODEL_ROLE_IDS;
export type ModelRole = "default";

/** Internal compatibility lookup; only `default` can have a configured value. */
export interface ModelRoleLookup {
	getModelRole(role: string): string | undefined;
}

export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}
