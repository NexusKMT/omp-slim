import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importSarifFile, SecurityStore } from "../../src/security";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "security", "generic-results.sarif");
let temporaryRoot = "";
let repositoryRoot = "";
let store: SecurityStore;

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-history-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
	store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
});

afterEach(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("security history and dispositions", () => {
	test("lists newest scans first and compares stable finding lineage", async () => {
		const before = await importSarifFile(FIXTURE, {
			repositoryRoot,
			createScanId: () => "secscan_historybefore",
			createdAt: "2026-07-29T00:00:00.000Z",
		});
		const after = await importSarifFile(FIXTURE, {
			repositoryRoot,
			createScanId: () => "secscan_historyafter",
			createdAt: "2026-07-29T00:05:00.000Z",
		});
		await store.putBundle(before);
		await store.putBundle(after);
		expect((await store.listScans()).map(scan => scan.id)).toEqual([
			"secscan_historyafter",
			"secscan_historybefore",
		]);
		const comparison = await store.compare(before.scan.id, after.scan.id);
		expect(comparison.unchanged).toBe(2);
		expect(comparison.introduced).toBe(0);
		expect(comparison.resolved).toBe(0);
	});

	test("persists an explicit disposition and rationale without changing finding identity", async () => {
		const bundle = await importSarifFile(FIXTURE, {
			repositoryRoot,
			createScanId: () => "secscan_disposition",
			createdAt: "2026-07-29T00:00:00.000Z",
		});
		await store.putBundle(bundle);
		const original = bundle.findings[0];
		if (!original) throw new Error("fixture must contain a finding");
		const updated = await store.updateDisposition(bundle.scan.id, original.id, {
			status: "false_positive",
			rationale: "The fixture proves the value is constrained before the sink.",
			updatedAt: "2026-07-29T00:10:00.000Z",
			actor: "test-operator",
		});
		expect(updated.id).toBe(original.id);
		expect(updated.fingerprint).toBe(original.fingerprint);
		expect(updated.disposition).toEqual({
			status: "false_positive",
			rationale: "The fixture proves the value is constrained before the sink.",
			updatedAt: "2026-07-29T00:10:00.000Z",
			actor: "test-operator",
		});
		expect((await store.getFinding(bundle.scan.id, original.id))?.disposition).toEqual(updated.disposition);
	});
});
