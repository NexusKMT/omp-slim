import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface SeedManifest {
	schemaVersion: number;
	nonProduction: boolean;
	seeds: Array<{ id: string; path: string; expectedClass: string; expectedDisposition: string }>;
}

const ROOT = path.join(import.meta.dir, "..", "fixtures", "security", "seeded-repository");

describe("security seeded validation repository", () => {
	test("manifest points only at present non-production fixture files", async () => {
		const manifest = (await Bun.file(path.join(ROOT, "manifest.json")).json()) as SeedManifest;
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.nonProduction).toBeTrue();
		expect(manifest.seeds).toHaveLength(8);
		for (const seed of manifest.seeds) {
			expect(seed.id.length).toBeGreaterThan(0);
			expect(seed.expectedClass.length).toBeGreaterThan(0);
			expect(["finding", "no-finding"]).toContain(seed.expectedDisposition);
			expect(await Bun.file(path.join(ROOT, seed.path)).exists()).toBeTrue();
		}
	});
});
