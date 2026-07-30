import type { SecurityLocation } from "./types";

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item !== undefined) result[key] = canonicalize(item);
	}
	return result;
}

export function canonicalSecurityJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function securitySha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function normalizeFingerprintPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizedLocations(
	locations: readonly SecurityLocation[],
): Array<Record<string, string | number | undefined>> {
	return locations
		.map(location => ({
			path: normalizeFingerprintPath(location.path),
			startLine: location.startLine,
			endLine: location.endLine,
			startColumn: location.startColumn,
			endColumn: location.endColumn,
			role: location.role,
		}))
		.sort((left, right) => {
			const byPath = String(left.path).localeCompare(String(right.path));
			if (byPath !== 0) return byPath;
			return Number(left.startLine) - Number(right.startLine);
		});
}

export interface SecurityFindingFingerprintInput {
	ruleId: string;
	category: string;
	anchor?: string;
	locations: readonly SecurityLocation[];
}

export function createSecurityFindingFingerprint(input: SecurityFindingFingerprintInput): string {
	const digest = securitySha256(
		canonicalSecurityJson({
			ruleId: input.ruleId.trim().toLowerCase(),
			category: input.category.trim().toLowerCase(),
			anchor: input.anchor?.trim().toLowerCase() || undefined,
			locations: normalizedLocations(input.locations),
		}),
	);
	return `omp-security/v1:sha256:${digest}`;
}

export function createSecurityFindingId(fingerprint: string): string {
	return `secf_${securitySha256(fingerprint).slice(0, 24)}`;
}

export function createSecurityOccurrenceId(fingerprint: string, locations: readonly SecurityLocation[]): string {
	const material = canonicalSecurityJson({ fingerprint, locations: normalizedLocations(locations) });
	return `seco_${securitySha256(material).slice(0, 24)}`;
}

export function createSecurityEvidenceId(fingerprint: string, label: string, ordinal: number): string {
	return `sece_${securitySha256(canonicalSecurityJson({ fingerprint, label, ordinal })).slice(0, 24)}`;
}

export function createSecurityScanId(randomUuid: () => string = () => Bun.randomUUIDv7()): string {
	return `secscan_${randomUuid().replaceAll("-", "")}`;
}

export function createSecurityPlanId(fingerprint: string): string {
	return `secplan_${securitySha256(fingerprint).slice(0, 24)}`;
}

export function encodeSecurityProjectKey(repositoryRoot: string): string {
	const normalized = repositoryRoot.replaceAll("\\", "/").replace(/\/$/, "");
	const readable = normalized
		.replace(/^\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	return `${readable || "project"}-${securitySha256(normalized).slice(0, 12)}`;
}
