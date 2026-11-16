import * as fs from "node:fs/promises";

/** Link a plugin directory. */
export async function linkPluginDirectory(target: string, linkPath: string): Promise<void> {
	await fs.symlink(target, linkPath, "dir");
}
