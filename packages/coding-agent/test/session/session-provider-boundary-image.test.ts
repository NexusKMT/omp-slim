import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SessionProviderBoundary,
	type SessionProviderBoundaryHost,
} from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function makeProxyModel(id: string, input: readonly ("text" | "image")[] = ["text", "image"]): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as ModelSpec);
}

function makeHost(active: Model<Api>, artifactsDir: string): SessionProviderBoundaryHost {
	return {
		agent: { telemetry: undefined },
		sessionManager: {},
		settings: Settings.isolated(),
		modelRegistry: {
			getAvailable: () => [],
		},
		model: () => active,
		sessionId: () => "test-session",
		localProtocolOptions: () => ({ getArtifactsDir: () => artifactsDir, getSessionId: () => "test-session" }),
		obfuscator: () => undefined,
	} as unknown as SessionProviderBoundaryHost;
}

describe("buildImageDescriptionNotice wire truth (#9697)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "boundary-wire-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("describes images for a text-only model, not for one whose wire input includes images", async () => {
		const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const textOnly = makeProxyModel("deepseek-v4-flash", ["text"]);
		const notice = await new SessionProviderBoundary(makeHost(textOnly, testDir)).buildImageDescriptionNotice([
			image,
		]);
		expect(notice).toBeDefined();
		expect(JSON.stringify(notice)).toContain("current model does not support image input");

		const vision = makeProxyModel("deepseek-v4-flash");
		const silent = await new SessionProviderBoundary(makeHost(vision, testDir)).buildImageDescriptionNotice([
			image,
		]);
		expect(silent).toBeUndefined();
	});
});
