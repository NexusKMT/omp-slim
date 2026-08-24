import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("provider default selection", () => {
	/**
	 * `pickDefaultAvailableModel` prefers the first model whose id equals its
	 * provider's declared default and falls through to `availableModels[0]`
	 * when nothing matches. Synthetic's default pointed at `hf:zai-org/GLM-5.1`
	 * after the provider moved to GLM-5.2, so an account with only
	 * `SYNTHETIC_API_KEY` opened on `hf:moonshotai/Kimi-K3` — first in catalog
	 * order — instead of the declared default.
	 */
	test("picks Synthetic's declared default over catalog order", () => {
		const available = getBundledModels("synthetic") as Model<Api>[];
		expect(available.length).toBeGreaterThan(0);
		expect(available[0]?.id).not.toBe(DEFAULT_MODEL_PER_PROVIDER.synthetic);

		const picked = pickDefaultAvailableModel(available);

		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.synthetic);
	});
});
