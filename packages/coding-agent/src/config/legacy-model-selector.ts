/** Read old main-model aliases at the configuration boundary. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";
export const DEFAULT_MODEL_ROLE_ALIAS = "*";
export interface ConfiguredModelLookup {
	getModel(): string | undefined;
}
