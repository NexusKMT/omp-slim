import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import securityScanDescription from "../prompts/tools/security-scan.md" with { type: "text" };
import { createSecurityEvidenceId, type SecurityEvidence, type SecurityValidationStatus } from "../security/contracts";
import type { SecurityOperationSnapshot } from "../security/coordinator";
import { getSecurityCoordinator } from "../security/coordinator";
import type { SecurityTargetRequest } from "../security/preflight";
import { SecurityStore } from "../security/store";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const securityScanSchema = type({
	action: "'preflight' | 'start' | 'status' | 'cancel' | 'validate'",
	"plan_id?": "string",
	"operation_id?": "string",
	"target_kind?": "'repository' | 'scoped_path' | 'ref_diff' | 'working_tree'",
	"include_paths?": "string[]",
	"exclude_paths?": "string[]",
	"base_revision?": "string",
	"head_revision?": "string",
	"knowledge_base_paths?": "string[]",
	"output_root?": "string",
	"archive_existing?": "boolean",
	"credential_id?": "number.integer >= 1",
	"scan_id?": "string",
	"finding_id?": "string",
	"validation_status?": "'unvalidated' | 'validated' | 'rejected' | 'partial' | 'error'",
	"validation_summary?": "string",
	"validation_evidence?": type({ label: "string > 0", explanation: "string" }).array(),
});

type SecurityScanParams = typeof securityScanSchema.infer;

export interface SecurityScanToolDetails {
	action: SecurityScanParams["action"];
	plan?: { id: string; fingerprint: string };
	operation?: SecurityOperationSnapshot;
	cancelled?: boolean;
	finding?: { id: string; validationStatus: SecurityValidationStatus };
}

function targetFromParams(params: SecurityScanParams): SecurityTargetRequest {
	const common = { includePaths: params.include_paths, excludePaths: params.exclude_paths };
	switch (params.target_kind ?? "repository") {
		case "scoped_path": {
			if (!params.include_paths?.some(value => value.trim().length > 0)) {
				throw new ToolError("scoped_path security scans require at least one include path");
			}
			return { kind: "scoped_path", includePaths: params.include_paths, excludePaths: params.exclude_paths };
		}
		case "working_tree":
			return { kind: "working_tree", ...common };
		case "ref_diff":
			if (!params.base_revision || !params.head_revision) {
				throw new ToolError("ref_diff preflight requires base_revision and head_revision");
			}
			return {
				kind: "ref_diff",
				baseRevision: params.base_revision,
				headRevision: params.head_revision,
				...common,
			};
		default:
			return { kind: "repository", ...common };
	}
}

function requireValue(value: string | undefined, label: string): string {
	if (!value?.trim()) throw new ToolError(`${label} is required for this action`);
	return value.trim();
}

function textResult(text: string, details: SecurityScanToolDetails): AgentToolResult<SecurityScanToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class SecurityScanTool implements AgentTool<typeof securityScanSchema, SecurityScanToolDetails> {
	readonly name = "security_scan";
	readonly approval: ToolTier = "exec";
	readonly label = "Security Scan";
	readonly loadMode = "discoverable";
	readonly summary = "Plan, run, and validate an OMP-native software-security scan";
	readonly description = securityScanDescription.trim();
	readonly parameters = securityScanSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SecurityScanParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SecurityScanToolDetails>> {
		if (!this.session.settings.get("security.enabled")) {
			throw new ToolError("Security is disabled. Enable security.enabled before using security_scan.");
		}
		const coordinatorForSession = () => {
			if (!this.session.modelRegistry || !this.session.authStorage) {
				throw new ToolError("Security scan requires the session model and authentication registries");
			}
			return getSecurityCoordinator({
				cwd: this.session.cwd,
				settings: this.session.settings,
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				activeModel: this.session.getActiveModel?.(),
				sessionId: this.session.getSessionId?.() ?? undefined,
				agentId: this.session.getAgentId?.() ?? undefined,
				asyncJobManager: this.session.asyncJobManager,
			});
		};
		switch (params.action) {
			case "preflight": {
				const model = this.session.getActiveModel?.();
				const plan = await coordinatorForSession().preflight({
					target: targetFromParams(params),
					knowledgeBasePaths: params.knowledge_base_paths,
					outputRoot: params.output_root,
					archiveExisting: params.archive_existing,
					credentialId: params.credential_id,
					model,
					signal,
				});
				return textResult(
					[
						`Security plan ${plan.id} is ready.`,
						`Fingerprint: ${plan.fingerprint}.`,
						`Start it with action=start and plan_id=${plan.id}.`,
					].join(" "),
					{ action: params.action, plan: { id: plan.id, fingerprint: plan.fingerprint } },
				);
			}
			case "start": {
				const operation = await coordinatorForSession().start({
					planId: requireValue(params.plan_id, "plan_id"),
				});
				return textResult(`Security scan ${operation.scanId} started as ${operation.operationId}.`, {
					action: params.action,
					operation,
				});
			}
			case "status": {
				const operationId = requireValue(params.operation_id, "operation_id");
				const operation = await coordinatorForSession().status(operationId);
				if (!operation) throw new ToolError(`Unknown security operation: ${operationId}`);
				return textResult(
					`Security scan ${operation.scanId}: ${operation.phase}; ${operation.findingCount} finding(s).`,
					{ action: params.action, operation },
				);
			}
			case "cancel": {
				const operationId = requireValue(params.operation_id, "operation_id");
				const cancelled = await coordinatorForSession().cancel(operationId);
				return textResult(
					cancelled ? `Cancellation requested for ${operationId}.` : `No running operation ${operationId}.`,
					{
						action: params.action,
						cancelled,
						operation: (await coordinatorForSession().status(operationId)) ?? undefined,
					},
				);
			}
			case "validate": {
				const scanId = requireValue(params.scan_id, "scan_id");
				const findingId = requireValue(params.finding_id, "finding_id");
				const status = params.validation_status;
				if (!status) throw new ToolError("validation_status is required for this action");
				const summary = requireValue(params.validation_summary, "validation_summary");
				const store = await SecurityStore.openForCwd(this.session.cwd, { signal });
				const finding = await store.getFinding(scanId, findingId);
				if (!finding) throw new ToolError(`Unknown security finding: ${findingId}`);
				const evidence: SecurityEvidence[] = (params.validation_evidence ?? []).map((item, index) => ({
					id: createSecurityEvidenceId(
						finding.fingerprint,
						`validation:${item.label}`,
						finding.evidence.length + index,
					),
					kind: "validation",
					label: item.label,
					explanation: item.explanation,
				}));
				const updated = await store.updateValidation(
					scanId,
					findingId,
					{
						status,
						summary,
						evidenceIds: evidence.map(item => item.id),
						validatedAt: new Date().toISOString(),
					},
					evidence,
				);
				return textResult(`Finding ${updated.id} validation is now ${updated.validation.status}.`, {
					action: params.action,
					finding: { id: updated.id, validationStatus: updated.validation.status },
				});
			}
		}
	}
}
