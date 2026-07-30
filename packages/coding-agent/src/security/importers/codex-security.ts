import * as path from "node:path";
import {
	createSecurityEvidenceId,
	createSecurityFindingFingerprint,
	createSecurityFindingId,
	createSecurityOccurrenceId,
	createSecurityScanId,
	encodeSecurityProjectKey,
	parseSecurityScanBundle,
	securitySha256,
} from "../contracts";
import type {
	SecurityCoverage,
	SecurityEvidence,
	SecurityFinding,
	SecurityLocation,
	SecurityProvenance,
	SecurityScanBundle,
} from "../contracts";

interface CodexManifest {
	documentType?: string;
	schemaVersion?: string;
	scan?: {
		id?: string;
		producer?: { name?: string; version?: string };
		status?: string;
		startedAt?: string;
		completedAt?: string;
		target?: Record<string, unknown>;
		scope?: { includePaths?: unknown; excludePaths?: unknown };
	};
}

interface CodexFinding {
	findingId?: string;
	occurrenceId?: string;
	ruleId?: string;
	identity?: { anchor?: string };
	fingerprints?: { algorithm?: string; primary?: string };
	title?: string;
	summary?: string;
	severity?: { level?: string; score?: number; scoringSystem?: string; vector?: string; rationale?: string };
	confidence?: { level?: string; rationale?: string };
	taxonomy?: { category?: string; cwe?: unknown };
	locations?: Array<{ path?: string; startLine?: number; endLine?: number; role?: string }>;
	codeEvidence?: Array<{
		id?: string;
		label?: string;
		path?: string;
		startLine?: number;
		endLine?: number;
		role?: string;
		code?: string;
		explanation?: string;
	}>;
	remediation?: string;
	validation?: Record<string, unknown> | null;
	provenance?: Record<string, unknown>;
	extensions?: Record<string, unknown>;
}

interface CodexFindingsDocument {
	documentType?: string;
	schemaVersion?: string;
	scanId?: string;
	findings?: CodexFinding[];
}

interface CodexCoverageDocument {
	documentType?: string;
	schemaVersion?: string;
	scanId?: string;
	mode?: string;
	completeness?: string;
	inventoryStrategy?: string;
	includePaths?: unknown;
	excludePaths?: unknown;
	surfaces?: unknown;
	explicitExclusions?: unknown;
	deferred?: unknown;
	openQuestions?: unknown;
}

interface CodexFixtureProvenance {
	repository?: string;
	revision?: string;
	packageVersion?: string;
	pluginVersion?: string;
	archiveSha256?: string;
}

export interface CodexSecurityImportOptions {
	repositoryRoot: string;
	createdAt?: string;
	createScanId?: () => string;
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await Bun.file(filePath).text()) as T;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function locationsForFinding(finding: CodexFinding): SecurityLocation[] {
	const locations = (finding.locations ?? [])
		.filter(location => typeof location.path === "string" && typeof location.startLine === "number")
		.map(location => ({
			path: location.path as string,
			startLine: location.startLine as number,
			endLine: location.endLine,
			role: location.role,
		}));
	return locations.length > 0 ? locations : [{ path: "unknown", startLine: 1, role: "unknown" }];
}

function mapCoverage(document: CodexCoverageDocument): SecurityCoverage {
	const allowedModes = new Set(["repository", "scoped_path", "diff", "working_tree", "deep_repository"]);
	const mode = allowedModes.has(document.mode ?? "")
		? (document.mode as SecurityCoverage["mode"])
		: document.mode === "commit" || document.mode === "branch_diff"
			? "diff"
			: "imported";
	const completeness = ["complete", "partial", "unknown"].includes(document.completeness ?? "")
		? (document.completeness as SecurityCoverage["completeness"])
		: "unknown";
	const inventoryStrategy = ["repository", "scoped_path", "diff", "directory", "custom"].includes(
		document.inventoryStrategy ?? "",
	)
		? (document.inventoryStrategy as SecurityCoverage["inventoryStrategy"])
		: "imported";
	return {
		mode,
		completeness,
		inventoryStrategy,
		includePaths: stringArray(document.includePaths),
		excludePaths: stringArray(document.excludePaths),
		surfaces: Array.isArray(document.surfaces) ? (document.surfaces as SecurityCoverage["surfaces"]) : [],
		explicitExclusions: Array.isArray(document.explicitExclusions)
			? (document.explicitExclusions as SecurityCoverage["explicitExclusions"])
			: [],
		deferred: Array.isArray(document.deferred) ? (document.deferred as SecurityCoverage["deferred"]) : [],
		openQuestions: Array.isArray(document.openQuestions)
			? (document.openQuestions as SecurityCoverage["openQuestions"])
			: undefined,
	};
}

export async function importCodexSecurityBundle(
	bundleDirectory: string,
	options: CodexSecurityImportOptions,
): Promise<SecurityScanBundle> {
	const root = path.resolve(bundleDirectory);
	const manifest = await readJson<CodexManifest>(path.join(root, "scan-manifest.json"));
	const findingsDocument = await readJson<CodexFindingsDocument>(path.join(root, "findings.json"));
	const coverageDocument = await readJson<CodexCoverageDocument>(path.join(root, "coverage.json"));
	if (manifest.documentType !== "codex-security.scan-manifest" || manifest.schemaVersion !== "1.0") {
		throw new Error("Unsupported Codex Security scan manifest");
	}
	if (findingsDocument.documentType !== "codex-security.findings" || findingsDocument.schemaVersion !== "1.0") {
		throw new Error("Unsupported Codex Security findings document");
	}
	if (coverageDocument.documentType !== "codex-security.coverage" || coverageDocument.schemaVersion !== "1.0") {
		throw new Error("Unsupported Codex Security coverage document");
	}
	if (
		!manifest.scan?.id ||
		findingsDocument.scanId !== manifest.scan.id ||
		coverageDocument.scanId !== manifest.scan.id
	) {
		throw new Error("Codex Security bundle scan IDs do not agree");
	}
	const fixtureProvenance = await readJson<CodexFixtureProvenance>(path.join(root, "PROVENANCE.json")).catch(() => ({}));
	const scanId = options.createScanId?.() ?? createSecurityScanId();
	const createdAt = options.createdAt ?? manifest.scan.startedAt ?? new Date().toISOString();
	const canonicalRoot = path.resolve(options.repositoryRoot);
	const producer = {
		kind: "codex-security-bundle" as const,
		name: manifest.scan.producer?.name || "codex-security",
		version: manifest.scan.producer?.version,
		vendor: "openai",
		revision: fixtureProvenance.revision,
		pluginVersion: fixtureProvenance.pluginVersion,
	};
	const upstream = {
		repository: fixtureProvenance.repository,
		revision: fixtureProvenance.revision,
		packageVersion: fixtureProvenance.packageVersion,
		pluginVersion: fixtureProvenance.pluginVersion,
		archiveSha256: fixtureProvenance.archiveSha256,
	};
	const findings: SecurityFinding[] = [];
	for (const source of findingsDocument.findings ?? []) {
		const ruleId = source.ruleId || "codex-security.unknown";
		const category = source.taxonomy?.category || ruleId.split(/[./-]/)[0] || "security";
		const locations = locationsForFinding(source);
		const fingerprint = createSecurityFindingFingerprint({
			ruleId,
			category,
			anchor: source.identity?.anchor,
			locations,
		});
		const evidence: SecurityEvidence[] = (source.codeEvidence ?? []).map((item, index) => ({
			id: createSecurityEvidenceId(fingerprint, item.label || item.id || "code evidence", index),
			kind: "code",
			label: item.label || item.id || `Evidence ${index + 1}`,
			explanation: item.explanation || "",
			location:
				typeof item.path === "string" && typeof item.startLine === "number"
					? {
						path: item.path,
						startLine: item.startLine,
						endLine: item.endLine,
						role: item.role,
					}
					: undefined,
			excerpt: item.code,
		}));
		const provenance: SecurityProvenance = {
			producer,
			createdAt,
			importedAt: new Date().toISOString(),
			sourceIds: {
				scanId: manifest.scan.id,
				...(source.findingId ? { findingId: source.findingId } : {}),
				...(source.occurrenceId ? { occurrenceId: source.occurrenceId } : {}),
			},
			vendorFingerprints: source.fingerprints?.primary
				? { [source.fingerprints.algorithm || "codex-security/v1"]: source.fingerprints.primary }
				: undefined,
			upstream,
			metadata: source.provenance,
		};
		findings.push({
			id: createSecurityFindingId(fingerprint),
			scanId,
			fingerprint,
			ruleId,
			anchor: source.identity?.anchor,
			title: source.title || ruleId,
			summary: source.summary || "",
			severity: {
				level: ["critical", "high", "medium", "low", "informational"].includes(source.severity?.level ?? "")
					? (source.severity?.level as SecurityFinding["severity"]["level"])
					: "informational",
				score: source.severity?.score,
				scoringSystem: source.severity?.scoringSystem,
				vector: source.severity?.vector,
				rationale: source.severity?.rationale,
			},
			confidence: {
				level: ["high", "medium", "low"].includes(source.confidence?.level ?? "")
					? (source.confidence?.level as SecurityFinding["confidence"]["level"])
					: "medium",
				rationale: source.confidence?.rationale,
			},
			taxonomy: { category, cwe: stringArray(source.taxonomy?.cwe) },
			occurrences: [
				{
					id: createSecurityOccurrenceId(fingerprint, locations),
					locations,
					evidenceIds: evidence.map(item => item.id),
				},
			],
			evidence,
			remediation: source.remediation,
			validation: {
				status: source.validation ? "validated" : "unvalidated",
				summary: source.validation ? JSON.stringify(source.validation) : undefined,
				evidenceIds: [],
			},
			disposition: { status: "open" },
			provenance,
			extensions: source.extensions,
		});
	}

	const target = manifest.scan.target ?? {};
	const sourceKind = String(target.kind ?? "");
	const targetKind =
		sourceKind === "git_diff" ? "ref_diff" : sourceKind === "git_worktree" ? "working_tree" : "imported";
	const reportPath = path.join(root, "report.md");
	const sarifPath = path.join(root, "exports", "results.sarif");
	const report = await Bun.file(reportPath).text().catch(() => undefined);
	const sarifText = await Bun.file(sarifPath).text().catch(() => undefined);
	const scanProvenance: SecurityProvenance = {
		producer,
		createdAt,
		importedAt: new Date().toISOString(),
		sourceIds: { scanId: manifest.scan.id },
		upstream,
		metadata: { bundleDirectory: root },
	};
	return parseSecurityScanBundle({
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: encodeSecurityProjectKey(canonicalRoot),
			status: "completed",
			createdAt,
			startedAt: manifest.scan.startedAt,
			completedAt: manifest.scan.completedAt ?? createdAt,
			target: {
				kind: targetKind,
				repositoryRoot: canonicalRoot,
				displayName: String(target.displayName ?? path.basename(canonicalRoot)),
				revision: typeof target.revision === "string" ? target.revision : undefined,
				baseRevision: typeof target.baseRevision === "string" ? target.baseRevision : undefined,
				headRevision: typeof target.headRevision === "string" ? target.headRevision : undefined,
				includePaths: stringArray(manifest.scan.scope?.includePaths),
				excludePaths: stringArray(manifest.scan.scope?.excludePaths),
				treeDigest:
					typeof target.snapshotDigest === "string"
						? target.snapshotDigest
						: securitySha256(JSON.stringify({ manifest, findingsDocument, coverageDocument })),
			},
			producer,
			provenance: scanProvenance,
			findingIds: findings.map(finding => finding.id),
			coverage: mapCoverage(coverageDocument),
			reportRef: report ? "report.md" : undefined,
			sarifRef: sarifText ? "results.sarif" : undefined,
		},
		findings,
		report,
		sarif: sarifText ? (JSON.parse(sarifText) as Record<string, unknown>) : undefined,
	});
}
