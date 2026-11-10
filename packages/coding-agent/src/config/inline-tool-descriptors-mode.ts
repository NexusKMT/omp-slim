/** Native Chat tool schemas are the default; inlining is an explicit option. */
export function shouldInlineToolDescriptors(setting: "auto" | "on" | "off" | undefined): boolean {
	return setting === "on";
}
