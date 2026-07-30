import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";

/** INI sections with `profile ` / `sso-session ` prefixes normalized. */
export type AwsIniFile = Record<string, Record<string, string>>;

export function parseAwsIni(text: string): AwsIniFile {
	const out: AwsIniFile = {};
	let current: Record<string, string> | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			let name = line.slice(1, -1).trim();
			if (name.startsWith("profile ")) name = name.slice(8).trim();
			if (name.startsWith("sso-session ")) name = `sso-session:${name.slice(12).trim()}`;
			let section = out[name];
			if (!section) {
				section = {};
				out[name] = section;
			}
			current = section;
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

function readAwsIniSync(filePath: string): AwsIniFile | undefined {
	try {
		return parseAwsIni(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export function hasConfiguredAwsProfile(profile = $env.AWS_PROFILE || "default"): boolean {
	const credentialsPath = $env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), ".aws", "credentials");
	const configPath = $env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
	const credentialsIni = readAwsIniSync(credentialsPath);
	const configIni = readAwsIniSync(configPath);
	const merged = { ...(configIni?.[profile] ?? {}), ...(credentialsIni?.[profile] ?? {}) };
	if (merged.aws_access_key_id && merged.aws_secret_access_key) return true;
	if (merged.credential_process) return true;
	if (!merged.sso_account_id || !merged.sso_role_name) return false;
	if (merged.sso_start_url && merged.sso_region) return true;
	const session = merged.sso_session ? configIni?.[`sso-session:${merged.sso_session}`] : undefined;
	return !!(session?.sso_start_url && session.sso_region);
}
