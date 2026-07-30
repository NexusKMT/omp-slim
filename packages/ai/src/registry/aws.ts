import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";

function isEc2Host(): boolean {
	if ($env.AWS_EXECUTION_ENV?.includes("EC2")) return true;
	for (const candidate of [
		"/sys/hypervisor/uuid",
		"/sys/devices/virtual/dmi/id/product_uuid",
		"/sys/devices/virtual/dmi/id/board_asset_tag",
	]) {
		try {
			const value = fs.readFileSync(candidate, "utf8").trim().toLowerCase();
			if (value.startsWith("ec2")) return true;
		} catch {
			// Missing/unreadable DMI metadata means this probe is inconclusive.
		}
	}
	return false;
}

export function hasAwsCredentialSource(): boolean {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	const credentialsPath = $env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), ".aws", "credentials");
	const configPath = $env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
	const hasProfile = !!$env.AWS_PROFILE || fs.existsSync(credentialsPath) || fs.existsSync(configPath);
	const hasInstanceRole =
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true" &&
		(!!$env.AWS_EC2_METADATA_SERVICE_ENDPOINT || isEc2Host());
	return !!(
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasWebIdentity ||
		hasProfile ||
		hasEcsCredentials ||
		hasInstanceRole
	);
}
