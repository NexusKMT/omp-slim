import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { helmcodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** helmcode.com/docs/models "Controlling reasoning"; host class ladders would send `xhigh`. */
const OPEN_WEIGHT_LADDER = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max];
const GLM_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];

function rosterFetch(ids: readonly string[]): FetchImpl {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ data: ids.map(id => ({ id, owned_by: "helmcode" })) }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as FetchImpl;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Helmcode provider support", () => {
	test("live roster drops non-chat SKUs, prunes retired seed rows, and keeps Helmcode's effort ladders", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-helmcode-"));
		// gemma4 is retired from the live roster; glm5.3-flash has no bundled row.
		const fetchMock = rosterFetch([
			"deepseek-v4-flash",
			"qwen3.6",
			"glm5.3",
			"glm5.3-flash",
			"qwen3-embedding",
			"rerank",
			"kokoro",
			"whisper",
		]);
		const options = {
			...helmcodeModelManagerOptions({ apiKey: "sk-helmcode", fetch: fetchMock }),
			staticModels: getBundledModels("helmcode"),
			cacheDbPath: path.join(tempDir, "models.db"),
		};

		try {
			const result = await resolveProviderModels(options, "online");
			const byId = new Map(result.models.map(model => [model.id, model]));

			expect([...byId.keys()].sort()).toEqual(["deepseek-v4-flash", "glm5.3", "glm5.3-flash", "qwen3.6"]);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.helmcode.com/v1/models",
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: "Bearer sk-helmcode" }),
				}),
			);
			expect(byId.get("deepseek-v4-flash")?.thinking?.efforts).toEqual(OPEN_WEIGHT_LADDER);
			expect(byId.get("qwen3.6")?.thinking?.efforts).toEqual(OPEN_WEIGHT_LADDER);
			expect(byId.get("glm5.3")?.thinking?.efforts).toEqual(GLM_LADDER);
			expect(byId.get("glm5.3-flash")?.thinking?.efforts).toEqual(GLM_LADDER);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
