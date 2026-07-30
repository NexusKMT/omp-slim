import * as path from "node:path";
import {
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
	SecurityFinding,
	SecurityLocation,
	SecurityProvenance,
	SecurityScanBundle,
	SecuritySeverityLevel,
} from "../contracts";

interface SarifRegion {
	startLine?: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
}

interface SarifPhysicalLocation {
	artifactLocation?: { uri?: string };
	region?: SarifRegion;
}

interface SarifResult {
	ruleId?: string;
	level?: string;
	message?: { text?: string; markdown?: string };
	locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
	fingerprints?: Record<string, string>;
	partialFingerprints?: Record<string, string>;
	properties?: Record<string, unknown>;
}

interface SarifRule {
	id?: string;
	name?: string;
	shortDescription?: { text?: string };
	properties?: { tags?: unknown } & Record<string, unknown>;
}

interface SarifRun {
	tool?: { driver?: { name?: string; version?: string; rules?: SarifRule[] } };
	results?: SarifResult[];
}

interface SarifLog {
	version?: string;
	runs?: SarifRun[];
}

export interface SarifImportOptions {
	repositoryRoot: string;
	sourcePath?: string;
	createdAt?: string;
	createScanId?: () => string;
}

function severityFromSarif(result: SarifResult): SecuritySeverityLevel {
	const score = Number(result.properties?.["security-severity"]);
	if (Number.isFinite(score)) {
		if (score >= 9) return "critical";
		if (score >= 7) return "high";
		if (score >= 4) return "medium";
		if (score > 0) return "low";
	}
	switch (result.level) {
		case "error":
			return "high";
		case "warning":
			return "medium";
		case "note":
			return "low";
		default:
			return "informational";
	}
}

function normalizeSarifLocations(result: SarifResult): SecurityLocation[] {
	const locations: SecurityLocation[] = [];
	for (const item of result.locations ?? []) {
		const physical = item.physicalLocation;
		const uri = physical?.artifactLocation?.uri;
		const startLine = physical?.region?.startLine;
		if (!uri || !startLine || startLine < 1) continue;
		locations.push({
			path: uri.replaceAll("\\", "/").replace(/^\.\//, ""),
			startLine,
			endLine: physical.region?.endLine,
			startColumn: physical.region?.startColumn,
			endColumn: physical.region?.endColumn,
			role: "primary",
		});
	}
	return locations.length > 0 ? locations : [{ path: "unknown", startLine: 1, role: "unknown" }];
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") result[key] = item;
	}
	return result;
}

function tagsForRule(rule: SarifRule | undefined): string[] {
	const tags = rule?.properties?.tags;
	return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

export async function importSarif(input: unknown, options: SarifImportOptions): Promise<SecurityScanBundle> {
	const sarif = input as SarifLog;
	if (sarif.version !== "2.1.0" || !Array.isArray(sarif.runs)) {
		throw new Error("Expected a SARIF 2.1.0 log with a runs array");
	}
	const canonicalRoot = path.resolve(options.repositoryRoot);
	const scanId = options.createScanId?.() ?? createSecurityScanId();
	const createdAt = options.createdAt ?? new Date().toISOString();
	const findings: SecurityFinding[] = [];
	let producerName = "SARIF importer";
	let producerVersion: string | undefined;

	for (const run of sarif.runs) {
		const driver = run.tool?.driver;
		producerName = driver?.name || producerName;
		producerVersion = driver?.version ?? producerVersion;
		const rules = new Map((driver?.rules ?? []).filter(rule => rule.id).map(rule => [rule.id as string, rule]));
		for (const result of run.results ?? []) {
			const ruleId = result.ruleId || "sarif.unknown";
			const rule = rules.get(ruleId);
			const locations = normalizeSarifLocations(result);
			const vendorFingerprints = {
				...stringRecord(result.fingerprints),
				...stringRecord(result.partialFingerprints),
			};
			const firstVendorFingerprint = Object.values(vendorFingerprints)[0];
			const category =
				typeof result.properties?.category === "string"
					? result.properties.category
					: ruleId.split(/[./-]/)[0] || "security";
			const fingerprint = createSecurityFindingFingerprint({
				ruleId,
				category,
				anchor: firstVendorFingerprint,
				locations,
			});
			const tags = tagsForRule(rule);
			const provenance: SecurityProvenance = {
				producer: { kind: "sarif-import", name: producerName, version: producerVersion },
				createdAt,
				importedAt: new Date().toISOString(),
				vendorFingerprints,
				metadata: options.sourcePath ? { sourcePath: options.sourcePath } : undefined,
			};
			const message = result.message?.text ?? result.message?.markdown ?? rule?.shortDescription?.text ?? ruleId;
			findings.push({
				id: createSecurityFindingId(fingerprint),
				scanId,
				fingerprint,
				ruleId,
				anchor: firstVendorFingerprint,
				title: rule?.shortDescription?.text ?? rule?.name ?? ruleId,
				summary: message,
				severity: {
					level: severityFromSarif(result),
					score: Number.isFinite(Number(result.properties?.["security-severity"]))
						? Number(result.properties?.["security-severity"])
						: undefined,
				},
				confidence: { level: "medium", rationale: "Imported from a SARIF producer" },
				taxonomy: {
					category,
					cwe: tags.filter(tag => /^CWE-\d+$/i.test(tag)).map(tag => tag.toUpperCase()),
					tags,
				},
				occurrences: [{ id: createSecurityOccurrenceId(fingerprint, locations), locations, evidenceIds: [] }],
				evidence: [],
				validation: { status: "unvalidated", evidenceIds: [] },
				disposition: { status: "open" },
				provenance,
			});
		}
	}

	const coverage: SecurityCoverage = {
		mode: "imported",
		completeness: "unknown",
		inventoryStrategy: "imported",
		includePaths: [],
		excludePaths: [],
		surfaces: [],
		explicitExclusions: [],
		deferred: [{ id: "sarif-coverage", reason: "SARIF does not define repository coverage" }],
	};
	const producer = { kind: "sarif-import" as const, name: producerName, version: producerVersion };
	const scanProvenance: SecurityProvenance = {
		producer,
		createdAt,
		importedAt: new Date().toISOString(),
		metadata: options.sourcePath ? { sourcePath: options.sourcePath } : undefined,
	};
	return parseSecurityScanBundle({
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: encodeSecurityProjectKey(canonicalRoot),
			status: "completed",
			createdAt,
			completedAt: createdAt,
			target: {
				kind: "imported",
				repositoryRoot: canonicalRoot,
				displayName: path.basename(canonicalRoot),
				includePaths: [],
				excludePaths: [],
				treeDigest: securitySha256(JSON.stringify(input)),
			},
			producer,
			provenance: scanProvenance,
			findingIds: findings.map(finding => finding.id),
			coverage,
			reportRef: "report.md",
			sarifRef: "results.sarif",
		},
		findings,
		report: `# Imported SARIF security results\n\nProducer: ${producerName}\n\nFindings: ${findings.length}\n`,
		sarif: input as Record<string, unknown>,
	});
}

export async function importSarifFile(
	filePath: string,
	options: Omit<SarifImportOptions, "sourcePath">,
): Promise<SecurityScanBundle> {
	return importSarif(JSON.parse(await Bun.file(filePath).text()) as unknown, {
		...options,
		sourcePath: path.resolve(filePath),
	});
}
