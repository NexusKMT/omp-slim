import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { describe, expect, test } from "bun:test";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";
import { createTestModel } from "../helpers/test-model";

function model(id: string, provider: string): Model<Api> {
	return createTestModel({ provider: provider, id: id });
}

const modelA = model("test-model-1", "test-a");
const modelAPrev = model("test-model-0", "test-a");
const modelB = model("test-model-2", "test-b");

const available = [modelA, modelB] as Model<Api>[];

/** Minimal registry stub: only the methods the facade and core resolver touch. */
function registry(): ModelRegistry {
	return {
		getAvailable: () => available,
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = modelA;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(modelA);
		active = modelB;
		expect(q.current()).toBe(modelB);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("test-a/test-model-1")).toBe(modelA);
		expect(q.resolve("test-model-2")?.provider).toBe("test-b");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(modelA)).toBe(q.family(modelAPrev));
		expect(q.family(modelA)).not.toBe(q.family(modelB));
	});
});
