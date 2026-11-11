import { describe, expect, test, vi } from "bun:test";
import { getTestModel } from "../../../catalog/test/fixtures/models";
import { createSecurityAuthResolver, selectSecurityAuth } from "../../src/security/auth";

describe("security scan Chat credentials", () => {
	test("binds a scan to its configured endpoint and refuses route changes", () => {
		const model = getTestModel("gateway", "configured");
		const resolve = vi.fn(() => "test-key");
		const resolver = createSecurityAuthResolver({ auth: selectSecurityAuth(model), providerResolver: resolve });
		expect(resolver(model)).toBe("test-key");
		expect(() => resolver({ ...model, provider: "other" })).toThrow("endpoint mismatch");
		expect(() => resolver({ ...model, api: "openai-responses" })).toThrow("endpoint mismatch");
		expect(resolve).toHaveBeenCalledTimes(1);
	});
	test("rejects a retired protocol or an old provider OAuth scan before resolving a key", () => {
		expect(() => selectSecurityAuth({ provider: "legacy", api: "anthropic-messages" })).toThrow("Chat Completions");
		const resolve = vi.fn(() => "must-not-resolve");
		expect(() =>
			createSecurityAuthResolver({ auth: { provider: "legacy", credentialId: 42 }, providerResolver: resolve }),
		).toThrow("retired provider login");
		expect(resolve).not.toHaveBeenCalled();
	});
});
