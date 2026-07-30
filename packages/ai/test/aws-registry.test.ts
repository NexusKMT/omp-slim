import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const EMPTY_AWS_ENV = {
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_PROFILE: undefined,
	AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
	AWS_ROLE_ARN: undefined,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
	AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
	AWS_EXECUTION_ENV: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT: undefined,
};

describe("AWS provider availability", () => {
	test("recognizes the default shared credentials file", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			await Bun.write(credentialsPath, "[default]\naws_access_key_id = test\n");
			await withEnv(
				{
					...EMPTY_AWS_ENV,
					AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
					AWS_CONFIG_FILE: path.join(tmp, "missing-config"),
					AWS_EC2_METADATA_DISABLED: "true",
				},
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("recognizes an explicitly configured EC2 metadata endpoint", async () => {
		await withEnv(
			{
				...EMPTY_AWS_ENV,
				AWS_SHARED_CREDENTIALS_FILE: "/missing/aws-credentials",
				AWS_CONFIG_FILE: "/missing/aws-config",
				AWS_EC2_METADATA_DISABLED: undefined,
				AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
			},
			async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
		);
	});
});
