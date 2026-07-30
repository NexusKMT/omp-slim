import { hasAwsCredentialSource } from "./aws";
import { AUTHENTICATED_SENTINEL, type ProviderDefinition } from "./types";

export const amazonBedrockProvider = {
	id: "amazon-bedrock",
	name: "Amazon Bedrock",
	// Amazon Bedrock accepts bearer tokens, IAM keys, profiles, ECS/IRSA credential chains.
	envKeys: () => (hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined),
} as const satisfies ProviderDefinition;
