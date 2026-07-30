import type { SecurityComparisonReport, SecurityFinding, SecurityFindingMatch, SecurityScanBundle } from "./contracts";

export interface SecurityDifferentialFindingMatch {
	referenceFindingId: string;
	candidateFindingId: string;
	basis: "fingerprint" | "rule_location";
}
export interface SecurityDifferentialFindingSummary {
	findingId: string;
	ruleId: string;
	title: string;
	severity: SecurityFinding["severity"]["level"];
	confidence: SecurityFinding["confidence"]["level"];
	validationStatus: SecurityFinding["validation"]["status"];
	dispositionStatus: SecurityFinding["disposition"]["status"];
	primaryLocation?: { path: string; startLine: number };
}

export interface SecurityDifferentialScanSummary {
	scanId: string;
	producer: SecurityScanBundle["scan"]["producer"];
	status: SecurityScanBundle["scan"]["status"];
	findingCount: number;
	actionableFindingCount: number;
	validatedFindingCount: number;
	rejectedFindingCount: number;
	coverage: SecurityScanBundle["scan"]["coverage"];
	metrics?: SecurityScanBundle["scan"]["metrics"];
}

export interface SecurityDifferentialReport {
	referenceScanId: string;
	candidateScanId: string;
	matches: SecurityDifferentialFindingMatch[];
	referenceOnlyFindingIds: string[];
	candidateOnlyFindingIds: string[];
	reference: SecurityDifferentialScanSummary;
	candidate: SecurityDifferentialScanSummary;
	referenceOnlyFindings: SecurityDifferentialFindingSummary[];
	candidateOnlyFindings: SecurityDifferentialFindingSummary[];
	referenceFindingCount: number;
	candidateFindingCount: number;
	matchedFindingCount: number;
	recallAgainstReference: number;
	precisionAgainstReference: number;
	jaccardOverlap: number;
}

function normalizedPrimaryLocation(finding: SecurityFinding): string | undefined {
	const location = finding.occurrences.flatMap(occurrence => occurrence.locations)[0];
	if (!location) return undefined;
	return `${location.path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase()}:${location.startLine}`;
}

function fallbackKey(finding: SecurityFinding): string | undefined {
	const location = normalizedPrimaryLocation(finding);
	if (!location) return undefined;
	return `${finding.ruleId.trim().toLowerCase()}\u0000${location}`;
}

function findingSummary(finding: SecurityFinding): SecurityDifferentialFindingSummary {
	const location = finding.occurrences.flatMap(occurrence => occurrence.locations)[0];
	return {
		findingId: finding.id,
		ruleId: finding.ruleId,
		title: finding.title,
		severity: finding.severity.level,
		confidence: finding.confidence.level,
		validationStatus: finding.validation.status,
		dispositionStatus: finding.disposition.status,
		...(location ? { primaryLocation: { path: location.path, startLine: location.startLine } } : {}),
	};
}

function scanSummary(bundle: SecurityScanBundle): SecurityDifferentialScanSummary {
	return {
		scanId: bundle.scan.id,
		producer: bundle.scan.producer,
		status: bundle.scan.status,
		findingCount: bundle.findings.length,
		actionableFindingCount: bundle.findings.filter(finding => finding.disposition.status === "open").length,
		validatedFindingCount: bundle.findings.filter(finding => finding.validation.status === "validated").length,
		rejectedFindingCount: bundle.findings.filter(finding => finding.validation.status === "rejected").length,
		coverage: bundle.scan.coverage,
		...(bundle.scan.metrics ? { metrics: bundle.scan.metrics } : {}),
	};
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? (numerator === 0 ? 1 : 0) : numerator / denominator;
}

export function compareSecurityProducers(
	reference: SecurityScanBundle,
	candidate: SecurityScanBundle,
): SecurityDifferentialReport {
	const candidateByFingerprint = new Map(candidate.findings.map(finding => [finding.fingerprint, finding]));
	const candidateByFallback = new Map<string, SecurityFinding[]>();
	for (const finding of candidate.findings) {
		const key = fallbackKey(finding);
		if (!key) continue;
		const bucket = candidateByFallback.get(key) ?? [];
		bucket.push(finding);
		candidateByFallback.set(key, bucket);
	}
	const usedCandidateIds = new Set<string>();
	const matches: SecurityDifferentialFindingMatch[] = [];
	for (const referenceFinding of reference.findings) {
		const exact = candidateByFingerprint.get(referenceFinding.fingerprint);
		if (exact && !usedCandidateIds.has(exact.id)) {
			usedCandidateIds.add(exact.id);
			matches.push({
				referenceFindingId: referenceFinding.id,
				candidateFindingId: exact.id,
				basis: "fingerprint",
			});
			continue;
		}
		const key = fallbackKey(referenceFinding);
		const fallback = key
			? candidateByFallback.get(key)?.find(finding => !usedCandidateIds.has(finding.id))
			: undefined;
		if (!fallback) continue;
		usedCandidateIds.add(fallback.id);
		matches.push({
			referenceFindingId: referenceFinding.id,
			candidateFindingId: fallback.id,
			basis: "rule_location",
		});
	}
	const matchedReferenceIds = new Set(matches.map(match => match.referenceFindingId));
	const referenceOnlyFindingIds = reference.findings
		.filter(finding => !matchedReferenceIds.has(finding.id))
		.map(finding => finding.id);
	const candidateOnlyFindingIds = candidate.findings
		.filter(finding => !usedCandidateIds.has(finding.id))
		.map(finding => finding.id);
	const unionSize = reference.findings.length + candidate.findings.length - matches.length;
	return {
		referenceScanId: reference.scan.id,
		candidateScanId: candidate.scan.id,
		matches,
		referenceOnlyFindingIds,
		reference: scanSummary(reference),
		candidate: scanSummary(candidate),
		referenceOnlyFindings: referenceOnlyFindingIds.map(findingId =>
			findingSummary(reference.findings.find(finding => finding.id === findingId)!),
		),
		candidateOnlyFindings: candidateOnlyFindingIds.map(findingId =>
			findingSummary(candidate.findings.find(finding => finding.id === findingId)!),
		),
		candidateOnlyFindingIds,
		referenceFindingCount: reference.findings.length,
		candidateFindingCount: candidate.findings.length,
		matchedFindingCount: matches.length,
		recallAgainstReference: ratio(matches.length, reference.findings.length),
		precisionAgainstReference: ratio(matches.length, candidate.findings.length),
		jaccardOverlap: ratio(matches.length, unionSize),
	};
}

export function compareSecurityLineage(
	before: SecurityScanBundle,
	after: SecurityScanBundle,
): SecurityComparisonReport {
	const differential = compareSecurityProducers(before, after);
	const beforeById = new Map(before.findings.map(finding => [finding.id, finding]));
	const afterById = new Map(after.findings.map(finding => [finding.id, finding]));
	const matches: SecurityFindingMatch[] = differential.matches.map(match => {
		const beforeFinding = beforeById.get(match.referenceFindingId);
		const afterFinding = afterById.get(match.candidateFindingId);
		if (!beforeFinding || !afterFinding) throw new Error("Security comparison produced an invalid finding reference");
		return {
			beforeFindingId: beforeFinding.id,
			afterFindingId: afterFinding.id,
			fingerprint: beforeFinding.fingerprint,
			status: "unchanged",
			matchBasis: match.basis,
		};
	});
	for (const findingId of differential.referenceOnlyFindingIds) {
		const finding = beforeById.get(findingId);
		if (!finding) continue;
		matches.push({ beforeFindingId: finding.id, fingerprint: finding.fingerprint, status: "resolved" });
	}
	for (const findingId of differential.candidateOnlyFindingIds) {
		const finding = afterById.get(findingId);
		if (!finding) continue;
		matches.push({ afterFindingId: finding.id, fingerprint: finding.fingerprint, status: "new" });
	}
	matches.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
	return {
		beforeScanId: before.scan.id,
		afterScanId: after.scan.id,
		matches,
		unchanged: matches.filter(match => match.status === "unchanged").length,
		introduced: matches.filter(match => match.status === "new").length,
		resolved: matches.filter(match => match.status === "resolved").length,
	};
}
