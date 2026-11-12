import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	describeAttachedImagesForTextModel,
	shouldDescribeImagesForTextModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-completions"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textModel: Model<"openai-completions"> = { ...visionModel, id: "gpt-4.1-mini", input: ["text"] };

const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
describe("text-only attachment preservation", () => {
	let testDir: string;
	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "saved-image-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("saves every attachment with a limitation note and performs no model request", async () => {
		const request = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			throw new Error("unexpected model request");
		});
		const blocks = await describeAttachedImagesForTextModel([image], {
			localProtocolOptions: { getArtifactsDir: () => testDir, getSessionId: () => "test-session" },
		});
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.text).toContain("current model does not support image input");
		expect(blocks[0]!.text).toContain("Select a primary model that supports images");
		const match = blocks[0]!.text.match(/path="local:\/\/([^"]+)"/);
		expect(match).not.toBeNull();
		expect((await fs.readFile(path.join(testDir, "local", match![1]!))).toString("base64")).toBe(TINY_PNG_BASE64);
		expect(request).not.toHaveBeenCalled();
	});

	it("reuses the saved path for identical images", async () => {
		const blocks = await describeAttachedImagesForTextModel([image, image], {
			localProtocolOptions: { getArtifactsDir: () => testDir, getSessionId: () => "test-session" },
		});
		expect(blocks[0]).toEqual(blocks[1]);
		expect(await fs.readdir(path.join(testDir, "local"))).toHaveLength(1);
	});

	it("requires preservation only for a current text-only model and honors blocked images", () => {
		expect(shouldDescribeImagesForTextModel(textModel, Settings.isolated({}))).toBe(true);
		expect(shouldDescribeImagesForTextModel(visionModel, Settings.isolated({}))).toBe(false);
		expect(shouldDescribeImagesForTextModel(undefined, Settings.isolated({}))).toBe(false);
		expect(shouldDescribeImagesForTextModel(textModel, Settings.isolated({ "images.blockImages": true }))).toBe(
			false,
		);
	});

	it("does not save attachments after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			describeAttachedImagesForTextModel(
				[image],
				{
					localProtocolOptions: { getArtifactsDir: () => testDir, getSessionId: () => "test-session" },
				},
				controller.signal,
			),
		).rejects.toThrow();
		expect(await fs.readdir(testDir)).toEqual([]);
	});
});
