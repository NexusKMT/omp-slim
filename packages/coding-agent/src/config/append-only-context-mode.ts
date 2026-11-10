/** Append-only normalization is enabled only by explicit configuration. */
export function shouldEnableAppendOnlyContext(setting: "auto" | "on" | "off" | undefined): boolean {
	return setting === "on";
}
