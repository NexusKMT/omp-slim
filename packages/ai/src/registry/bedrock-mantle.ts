import { hasAwsCredentialSource } from "./aws";
import { AUTHENTICATED_SENTINEL, type ProviderDefinition } from "./types";

export const bedrockMantleProvider = {
	id: "bedrock-mantle",
	name: "Amazon Bedrock Mantle",
	envKeys: () => (hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined),
} as const satisfies ProviderDefinition;
