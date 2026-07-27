import { describe, expect, test } from "bun:test";
import { createReferenceResolver } from "../src/provider-models/bundled-references";
import type { ModelSpec } from "../src/types";

const FIXTURE = `${import.meta.dir}/fixtures/bundled-reference-laziness.ts`;

describe("bundled reference laziness", () => {
	test("constructing bundled model-manager options does not enrich bundled models", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, FIXTURE],
			env: process.env,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({ buildCalls: 0 });
	});

	test("a lazy provider-reference factory initializes on first resolution and only once", () => {
		const reference = {
			id: "fixture-model",
			name: "Fixture Model",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		} satisfies ModelSpec<"openai-completions">;
		let factoryCalls = 0;
		const resolveReference = createReferenceResolver(() => {
			factoryCalls++;
			return new Map([[reference.id, reference]]);
		});

		expect(factoryCalls).toBe(0);
		expect(resolveReference(reference.id)).toBe(reference);
		expect(resolveReference(reference.id)).toBe(reference);
		expect(factoryCalls).toBe(1);
	});
});
