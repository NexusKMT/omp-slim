import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { getSecurityCoordinator } from "../../security/coordinator";
import type { SecurityPreflightInput } from "../../security/coordinator";
import type { SecurityDispositionStatus } from "../../security/contracts";
import { importCodexSecurityBundle, importSarifFile } from "../../security/importers";
import type { SecurityTargetRequest } from "../../security/preflight";
import { SecurityProtocolHandler } from "../../internal-urls/security-protocol";
import { parseInternalUrl } from "../../internal-urls/parse";
import { SecurityStore, writeSecurityFileAtomic } from "../../security/store";
import validationRequestPrompt from "../../prompts/security/validate-request.md" with { type: "text" };
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

interface SecurityPlanCliOptions {
	target: SecurityTargetRequest;
	knowledgeBasePaths: string[];
	outputRoot?: string;
	archiveExisting?: boolean;
	credentialId?: number;
}

const DISPOSITIONS: ReadonlySet<SecurityDispositionStatus> = new Set([
	"open",
	"false_positive",
	"accepted_risk",
	"fixed",
	"wont_fix",
]);

function coordinatorFor(runtime: SlashCommandRuntime) {
	return getSecurityCoordinator({
		cwd: runtime.cwd,
		settings: runtime.settings,
		authStorage: runtime.session.modelRegistry.authStorage,
		modelRegistry: runtime.session.modelRegistry,
		activeModel: runtime.session.model,
		sessionId: runtime.session.sessionId,
		agentId: runtime.session.getAgentId(),
		asyncJobManager: runtime.session.asyncJobManager,
	});
}

function requireToken(tokens: readonly string[], index: number, flag: string): string {
	const value = tokens[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parsePositiveCredential(value: string): number {
	const credentialId = Number(value);
	if (!Number.isSafeInteger(credentialId) || credentialId < 1) throw new Error(`Invalid credential id: ${value}`);
	return credentialId;
}

function parsePlanOptions(rest: string): SecurityPlanCliOptions {
	const tokens = parseCommandArgs(rest);
	const includePaths: string[] = [];
	const excludePaths: string[] = [];
	const knowledgeBasePaths: string[] = [];
	let kind: SecurityTargetRequest["kind"] = "repository";
	let baseRevision: string | undefined;
	let headRevision: string | undefined;
	let outputRoot: string | undefined;
	let archiveExisting = false;
	let credentialId: number | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		switch (token) {
			case "--path":
				includePaths.push(requireToken(tokens, ++index, token));
				kind = "scoped_path";
				break;
			case "--exclude":
				excludePaths.push(requireToken(tokens, ++index, token));
				break;
			case "--working-tree":
				kind = "working_tree";
				break;
			case "--diff":
				kind = "ref_diff";
				baseRevision = requireToken(tokens, ++index, token);
				headRevision = requireToken(tokens, ++index, token);
				break;
			case "--knowledge-base":
				knowledgeBasePaths.push(requireToken(tokens, ++index, token));
				break;
			case "--output":
				outputRoot = requireToken(tokens, ++index, token);
				break;
			case "--archive-existing":
				archiveExisting = true;
				break;
			case "--credential":
				credentialId = parsePositiveCredential(requireToken(tokens, ++index, token));
				break;
			default:
				throw new Error(`Unknown security plan option: ${token}`);
		}
	}
	const common = { includePaths, excludePaths };
	const target: SecurityTargetRequest =
		kind === "ref_diff"
			? {
					kind,
					baseRevision: baseRevision ?? "",
					headRevision: headRevision ?? "",
					...common,
				}
			: kind === "working_tree"
				? { kind, ...common }
				: kind === "scoped_path"
					? { kind, ...common }
					: { kind: "repository", ...common };
	return { target, knowledgeBasePaths, outputRoot, archiveExisting, credentialId };
}

async function preflight(runtime: SlashCommandRuntime, rest: string) {
	const options = parsePlanOptions(rest);
	const input: SecurityPreflightInput = {
		target: options.target,
		knowledgeBasePaths: options.knowledgeBasePaths,
		outputRoot: options.outputRoot,
		archiveExisting: options.archiveExisting,
		credentialId: options.credentialId,
		model: runtime.session.model,
	};
	return coordinatorFor(runtime).preflight(input);
}

function scanIdFromInput(value: string): string {
	const trimmed = value.trim();
	const match = trimmed.match(/^security:\/\/scans\/([^/]+)/);
	return match?.[1] ?? trimmed;
}

function findingUri(value: string): string {
	const trimmed = value.trim();
	if (/^security:\/\/scans\/[^/]+\/findings\/[^/]+$/.test(trimmed)) return trimmed;
	const [scanId, findingId] = parseCommandArgs(trimmed);
	if (!scanId || !findingId) throw new Error("validate requires a finding URI or <scan-id> <finding-id>");
	return `security://scans/${scanId}/findings/${findingId}`;
}

async function showResource(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const raw = rest.trim();
	if (!raw) throw new Error("show requires a scan id or security:// URI");
	const uri = raw.startsWith("security://") ? raw : `security://scans/${scanIdFromInput(raw)}`;
	const handler = new SecurityProtocolHandler(undefined, () => true);
	const resource = await handler.resolve(parseInternalUrl(uri), { cwd: runtime.cwd });
	await runtime.output(resource.content);
}

async function importResults(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const [source] = parseCommandArgs(rest);
	if (!source) throw new Error("import requires a SARIF file or Codex Security bundle directory");
	const absolute = path.resolve(runtime.cwd, source);
	const stats = await fs.stat(absolute);
	const bundle = stats.isDirectory()
		? await importCodexSecurityBundle(absolute, { repositoryRoot: runtime.cwd })
		: await importSarifFile(absolute, { repositoryRoot: runtime.cwd });
	const store = await SecurityStore.open(runtime.cwd);
	await store.putBundle(bundle);
	await runtime.output(`Imported ${bundle.findings.length} finding(s) as security scan ${bundle.scan.id}.`);
}

async function exportResults(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const tokens = parseCommandArgs(rest);
	const scanId = tokens[0];
	if (!scanId) throw new Error("export requires <scan-id> --output <path> [--format bundle|sarif|report]");
	let outputPath: string | undefined;
	let format: "bundle" | "sarif" | "report" = "bundle";
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--output") outputPath = requireToken(tokens, ++index, token);
		else if (token === "--format") {
			const value = requireToken(tokens, ++index, token);
			if (value !== "bundle" && value !== "sarif" && value !== "report") {
				throw new Error(`Unknown export format: ${value}`);
			}
			format = value;
		} else throw new Error(`Unknown export option: ${token}`);
	}
	if (!outputPath) throw new Error("export requires --output <path>");
	const store = await SecurityStore.open(runtime.cwd);
	const bundle = await store.getBundle(scanIdFromInput(scanId));
	if (!bundle) throw new Error(`Unknown security scan: ${scanId}`);
	let content: string;
	if (format === "sarif") {
		if (!bundle.sarif) throw new Error(`Security scan ${scanId} has no SARIF result`);
		content = `${JSON.stringify(bundle.sarif, null, 2)}\n`;
	} else if (format === "report") {
		if (bundle.report === undefined) throw new Error(`Security scan ${scanId} has no report`);
		content = bundle.report;
	} else {
		content = `${JSON.stringify(bundle, null, 2)}\n`;
	}
	const absolute = path.resolve(runtime.cwd, outputPath);
	await writeSecurityFileAtomic(absolute, content);
	await runtime.output(`Exported security scan ${scanId} to ${absolute}.`);
}

async function updateDisposition(runtime: SlashCommandRuntime, rest: string): Promise<void> {
	const [scanId, findingId, status, ...rationaleParts] = parseCommandArgs(rest);
	if (!scanId || !findingId || !status) {
		throw new Error("disposition requires <scan-id> <finding-id> <status> [rationale]");
	}
	if (!DISPOSITIONS.has(status as SecurityDispositionStatus)) throw new Error(`Unknown disposition: ${status}`);
	const rationale = rationaleParts.join(" ").trim();
	if (status !== "open" && !rationale) throw new Error(`${status} requires a rationale`);
	const store = await SecurityStore.open(runtime.cwd);
	const finding = await store.updateDisposition(scanId, findingId, {
		status: status as SecurityDispositionStatus,
		rationale: rationale || undefined,
		updatedAt: new Date().toISOString(),
		actor: "operator",
	});
	await runtime.output(`Finding ${finding.id} disposition is now ${finding.disposition.status}.`);
}

export async function handleSecurityCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!runtime.settings.get("security.enabled")) {
		return usage("Security is disabled. Enable security.enabled before using /security.", runtime);
	}
	const { verb, rest } = parseSubcommand(command.args);
	try {
		switch (verb || "scans") {
			case "plan": {
				const plan = await preflight(runtime, rest);
				await runtime.output(`Security plan ${plan.id} is ready. Fingerprint: ${plan.fingerprint}.`);
				return commandConsumed();
			}
			case "scan": {
				const coordinator = coordinatorFor(runtime);
				const planId = rest.trim().startsWith("secplan_") ? rest.trim() : (await preflight(runtime, rest)).id;
				const operation = await coordinator.start({ planId });
				await runtime.output(`Security scan ${operation.scanId} started as ${operation.operationId}.`);
				return commandConsumed();
			}
			case "status": {
				const coordinator = coordinatorFor(runtime);
				const operationId = rest.trim();
				if (operationId) {
					const operation = coordinator.status(operationId);
					if (!operation) throw new Error(`Unknown security operation: ${operationId}`);
					await runtime.output(JSON.stringify(operation, null, 2));
				} else {
					await runtime.output(JSON.stringify(coordinator.listOperations(), null, 2));
				}
				return commandConsumed();
			}
			case "cancel": {
				const operationId = rest.trim();
				if (!operationId) throw new Error("cancel requires an operation id");
				await runtime.output(
					coordinatorFor(runtime).cancel(operationId)
						? `Cancellation requested for ${operationId}.`
						: `No cancellable security operation ${operationId}.`,
				);
				return commandConsumed();
			}
			case "scans": {
				const scans = await (await SecurityStore.open(runtime.cwd)).listScans();
				await runtime.output(
					scans.length === 0
						? "No security scans are stored for this project."
						: scans.map(scan => `${scan.id} ${scan.status} ${scan.findingCount} finding(s) ${scan.producer.name}`).join("\n"),
				);
				return commandConsumed();
			}
			case "show":
				await showResource(runtime, rest);
				return commandConsumed();
			case "import":
				await importResults(runtime, rest);
				return commandConsumed();
			case "export":
				await exportResults(runtime, rest);
				return commandConsumed();
			case "validate":
				return { prompt: prompt.render(validationRequestPrompt, { findingUri: findingUri(rest) }).trim() };
			case "compare": {
				const [beforeScanId, afterScanId] = parseCommandArgs(rest);
				if (!beforeScanId || !afterScanId) throw new Error("compare requires <before-scan-id> <after-scan-id>");
				const report = await (await SecurityStore.open(runtime.cwd)).compare(beforeScanId, afterScanId);
				await runtime.output(JSON.stringify(report, null, 2));
				return commandConsumed();
			}
			case "disposition":
				await updateDisposition(runtime, rest);
				return commandConsumed();
			default:
				return usage(
					"Usage: /security <plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
					runtime,
				);
		}
	} catch (error) {
		await runtime.output(`Security: ${errorMessage(error)}`);
		return commandConsumed();
	}
}
