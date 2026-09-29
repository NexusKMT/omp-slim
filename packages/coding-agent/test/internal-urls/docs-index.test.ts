import { describe, expect, it } from "bun:test";
import { decodeDocsIndex } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { buildDocsIndexPayload } from "../../scripts/generate-docs-index";

const files = ["agent.md", "tools/read.md"];

// The embed path only runs in compiled binaries / the npm bundle; dev tests
// otherwise exercise the disk fallback (empty placeholder), so a regression in
// the two-line `<filenames>\n<gzip bodies>` parsing would ship broken `omp://`
// docs undetected. Body resolution is covered by the generator round-trip below.
describe("decodeDocsIndex (embedded docs path)", () => {
	it("lists filenames from the first line without inflating the blob", () => {
		// A deliberately corrupt blob: filenames must resolve anyway, proving the
		// listing path never decodes the gzip body.
		const index = decodeDocsIndex(`${JSON.stringify(files)}\n@@@not-a-valid-gzip-blob@@@`);
		expect(index?.filenames).toEqual(files);
	});

	it("returns null when there is no newline separator (empty placeholder)", () => {
		expect(decodeDocsIndex("")).toBeNull();
	});
});

describe("shipped docs embed (generator↔runtime contract)", () => {
	// bundle-dist.ts writes buildDocsIndexPayload().payload to
	// dist/docs-index.generated.txt, which docs-index.ts reads back via
	// decodeDocsIndex for npm/SDK consumers. If the generator's encoding and the
	// runtime decoder drift, the shipped embed silently fails to resolve, so
	// assert the real generator output round-trips through the runtime decoder.
	it("decodes the real generator payload with round-tripped filenames and bodies", async () => {
		const payload = await buildDocsIndexPayload();
		const index = decodeDocsIndex(payload.payload);
		expect(index).not.toBeNull();
		expect(index?.filenames).toEqual([...payload.files]);
		for (const [i, file] of payload.files.entries()) {
			expect(await index?.getBody(file)).toBe(payload.bodies[i]);
		}
		expect(await index?.getBody("missing.md")).toBeUndefined();
	});
});
