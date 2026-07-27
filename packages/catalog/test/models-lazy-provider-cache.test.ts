import { expect, spyOn, test } from "bun:test";
import * as buildModule from "../src/build";
import { getBundledModel, getBundledModels, getBundledProviders, type GeneratedProvider } from "../src/models";
import MODELS from "../src/models.json" with { type: "json" };

test("bundled models are enriched one provider at a time", () => {
	const buildSpy = spyOn(buildModule, "buildModel");
	const rawProviders = Object.keys(MODELS) as GeneratedProvider[];
	const firstProviders = getBundledProviders();
	const secondProviders = getBundledProviders();

	expect(buildSpy).toHaveBeenCalledTimes(0);
	expect(firstProviders).toEqual(rawProviders);
	expect(secondProviders).toEqual(rawProviders);
	expect(secondProviders).not.toBe(firstProviders);

	const provider = "sakana" satisfies GeneratedProvider;
	const rawModelIds = Object.keys(MODELS[provider]);
	const firstModels = getBundledModels(provider);

	expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);
	expect(firstModels.map(model => model.id)).toEqual(rawModelIds);

	const secondModels = getBundledModels(provider);
	expect(secondModels).not.toBe(firstModels);
	expect(secondModels).toHaveLength(firstModels.length);
	for (let index = 0; index < firstModels.length; index++) {
		expect(secondModels[index]).toBe(firstModels[index]);
	}
	expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

	const firstModelId = rawModelIds[0];
	if (firstModelId === undefined) throw new Error(`${provider} must have a bundled model`);
	expect(getBundledModel(provider, firstModelId)).toBe(firstModels[0]);
	expect(getBundledModel(provider, firstModelId)).toBe(firstModels[0]);
	expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

	const unknownProvider = "not-a-bundled-provider" as GeneratedProvider;
	expect(getBundledModels(unknownProvider)).toEqual([]);
	expect(getBundledModel(unknownProvider, "missing-model")).toBeUndefined();
	expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

	buildSpy.mockRestore();
});
