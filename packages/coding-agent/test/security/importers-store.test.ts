import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importCodexSecurityBundle, importSarifFile, SecurityStore } from "../../src/security";

const FIXTURE_ROOT = path.join(import.meta.dir, "..", "fixtures", "security");
let temporaryRoot = "";
let repositoryRoot = "";

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-store-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
});

afterEach(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("security importers and store", () => {
	test("Codex and generic SARIF producers normalize into one store", async () => {
		const store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
		const codex = await importCodexSecurityBundle(path.join(FIXTURE_ROOT, "codex-security-completed"), {
			repositoryRoot,
			createScanId: () => "secscan_codexfixture",
			createdAt: "2026-07-29T00:00:00.000Z",
		});
		const sarif = await importSarifFile(path.join(FIXTURE_ROOT, "generic-results.sarif"), {
			repositoryRoot,
			createScanId: () => "secscan_sariffixture",
			createdAt: "2026-07-29T00:01:00.000Z",
		});
		await store.putBundle(codex);
		await store.putBundle(sarif);
		const scans = await store.listScans();
		expect(scans.map(scan => scan.id).sort()).toEqual(["secscan_codexfixture", "secscan_sariffixture"]);
		expect((await store.getBundle("secscan_codexfixture"))?.findings).toHaveLength(1);
		expect((await store.getBundle("secscan_sariffixture"))?.findings).toHaveLength(2);
		expect(codex.scan.producer.kind).toBe("codex-security-bundle");
		expect(sarif.scan.producer.kind).toBe("sarif-import");
	});

	test("serializes concurrent index updates without losing scans", async () => {
		const store = await SecurityStore.open(repositoryRoot, { stateRoot: path.join(temporaryRoot, "state") });
		const bundles = await Promise.all(
			["one", "two", "three"].map((suffix, index) =>
				importSarifFile(path.join(FIXTURE_ROOT, "generic-results.sarif"), {
					repositoryRoot,
					createScanId: () => `secscan_concurrent${suffix}`,
					createdAt: `2026-07-29T00:0${index}:00.000Z`,
				}),
			),
		);
		await Promise.all(bundles.map(bundle => store.putBundle(bundle)));
		expect((await store.listScans()).map(scan => scan.id).sort()).toEqual([
			"secscan_concurrentone",
			"secscan_concurrentthree",
			"secscan_concurrenttwo",
		]);
	});

	test("store files remain outside the repository and private", async () => {
		const stateRoot = path.join(temporaryRoot, "state");
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		expect(store.projectDirectory.startsWith(repositoryRoot)).toBeFalse();
		if (process.platform !== "win32") {
			const mode = (await fs.stat(store.projectDirectory)).mode & 0o777;
			expect(mode).toBe(0o700);
		}
	});
});
