import { canonicalSecurityJson, securitySha256 } from "./contracts";
import type { SecurityAccountRef, SecurityProducer, SecurityProvenance } from "./contracts";

export const CODEX_SECURITY_UPSTREAM = {
	repository: "https://github.com/openai/codex-security",
	revision: "f22d4a36f26d16287bcdfd707b369116e02a08c3",
	packageVersion: "0.1.1",
	pluginVersion: "0.1.14",
	archiveSha256: "13745c495b7c5cf5273cf2115df86b9c3ec3056f43151c869e004aa3f30bcffb",
} as const;

export const OMP_SECURITY_WORKFLOW_VERSION = "1.0.0";

export function createNativeSecurityProducer(): SecurityProducer {
	return {
		kind: "omp-native",
		name: "OMP Native Security",
		version: OMP_SECURITY_WORKFLOW_VERSION,
	};
}

export function createNativeSecurityProvenance(options: {
	createdAt: string;
	account: SecurityAccountRef;
	planFingerprint: string;
	workflowFingerprint: string;
	sessionId?: string;
}): SecurityProvenance {
	const producer = createNativeSecurityProducer();
	return {
		producer,
		createdAt: options.createdAt,
		upstream: { ...CODEX_SECURITY_UPSTREAM },
		metadata: {
			planFingerprint: options.planFingerprint,
			workflowFingerprint: options.workflowFingerprint,
			sessionId: options.sessionId,
			account: {
				provider: options.account.provider,
				credentialId: options.account.credentialId,
				accountId: options.account.accountId,
				email: options.account.email,
				organizationId: options.account.organizationId,
				organizationName: options.account.organizationName,
			},
		},
	};
}

export function createSecurityWorkflowFingerprint(inputs: readonly string[]): string {
	return `omp-security-workflow/v1:sha256:${securitySha256(
		canonicalSecurityJson({
			workflowVersion: OMP_SECURITY_WORKFLOW_VERSION,
			upstream: CODEX_SECURITY_UPSTREAM,
			inputs,
		}),
	)}`;
}
