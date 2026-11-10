import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getTestModel } from "../../../catalog/test/fixtures/models";
import {
	extractExplicitThinkingSelector,
	parseModelPattern,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
	resolveModelScope,
	resolvePrimaryModelSelection,
} from "../../src/config/model-resolver";
import { Settings } from "../../src/config/settings";

describe("manual endpoint model selection", () => {
	const primary = getTestModel("gateway", "primary");
	const other = getTestModel("second", "primary");
	const literal = getTestModel("gateway", "release:high");
	const routedName = getTestModel("gateway", "name@literal");
	const models = [primary, other, literal, routedName];
	const registry = {
		getAll: () => models,
		getAvailable: () => models,
		hasProvider: (id: string) => id === "gateway" || id === "second",
	};

	it("selects exact configured identity and preserves literal colon and at-sign IDs", () => {
		expect(parseModelPattern("gateway/primary", models).model).toBe(primary);
		expect(parseModelPattern("gateway/release:high", models)).toMatchObject({
			model: literal,
			explicitThinkingLevel: false,
		});
		expect(parseModelPattern("gateway/name@literal", models).model).toBe(routedName);
		expect(
			extractExplicitThinkingSelector("gateway/release:high", undefined, {
				isLiteralModelId: (provider, id) => models.some(model => model.provider === provider && model.id === id),
			}),
		).toBeUndefined();
	});

	it("allows an explicit thinking suffix on a configured model", () => {
		expect(parseModelPattern("gateway/primary:high", models)).toMatchObject({
			model: primary,
			thinkingLevel: Effort.High,
			explicitThinkingLevel: true,
		});
	});

	it("does not reroute old upstream selectors or provider-pinned missing models", () => {
		expect(parseModelPattern("gateway/primary@other", models).model).toBeUndefined();
		expect(parseModelPattern("gateway/missing", models).model).toBeUndefined();
		expect(resolveModelOverride(["missing"], registry, undefined, { exactOnly: true }).model).toBeUndefined();
	});

	it("keeps only the default historical alias", () => {
		const settings = Settings.isolated({ model: "gateway/primary" });
		expect(resolveConfiguredModelPatterns("@default:high", settings)).toEqual(["gateway/primary:high"]);
		expect(resolveConfiguredModelPatterns("@smol", settings)).toEqual([]);
		expect(resolveCliModel({ cliModel: "@default", modelRegistry: registry, settings }).model).toBe(primary);
	});

	it("inherits the exact active object instead of replacing temporary transport with config", () => {
		const settings = Settings.isolated({ model: "second/primary" });
		const resolveHeaders = async () => ({ "x-active": "yes" });
		const active = { ...primary, baseUrl: "https://temporary.example.invalid/v1", resolveHeaders };
		expect(resolvePrimaryModelSelection(settings, models, active)?.model).toBe(active);
		expect(resolvePrimaryModelSelection(settings, models)?.model).toBe(other);
	});

	it("keeps a manually requested endpoint even when another endpoint has credentials", () => {
		const result = resolveCliModel({
			cliModel: "gateway/primary",
			modelRegistry: { ...registry, getAvailable: () => [other] },
		});
		expect(result.model).toBe(primary);
	});

	it("rejects disabled endpoints instead of selecting a similarly named model", () => {
		const result = resolveCliModel({
			cliModel: "gateway/primary",
			modelRegistry: registry,
			settings: Settings.isolated({ disabledProviders: ["gateway"] }),
		});
		expect(result.model).toBeUndefined();
		expect(result.disabledProvider).toBe("gateway");
	});

	it("supports explicit model filters without discovering or inventing entries", async () => {
		const scoped = await resolveModelScope(["gateway/*"], registry);
		expect(scoped.map(entry => entry.model)).toEqual([primary, literal, routedName]);
	});
});
