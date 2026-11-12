import { afterEach, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imagePreservation from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { ONE_PIXEL_PNG as PNG } from "./helpers/skill-image";

const skill: Pick<CustomMessage, "customType" | "content" | "display" | "attribution" | "details"> = {
	customType: "skill-prompt",
	content: [
		{ type: "text", text: "Expanded skill. What is in the image?" },
		{ type: "image", data: PNG, mimeType: "image/png" },
	],
	display: true,
	attribution: "user",
	details: { name: "review", args: "describe" },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

function setup(options: { responses?: MockResponseSource; beforeImageNotice?: () => Promise<void> } = {}) {
	const tempDir = TempDir.createSync("@skill-image-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("zai", "test-key");
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		model: "zai/glm-5.3",
	});
	const mock = createMockModel({ responses: options.responses, handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			// Text-only fixture: the skill-image tests exercise the image-preservation notice path,
			// which only triggers when the active model does not support image input.
			model: getBundledModel("zai", "glm-5.3", { input: ["text"] }),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: registry,
		toolRegistry: new Map(),
	});
	const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected auxiliary model request"));
	const saveImages = imagePreservation.describeAttachedImagesForTextModel;
	const saveImagesSpy = spyOn(imagePreservation, "describeAttachedImagesForTextModel").mockImplementation(
		async (...args) => {
			const notice = await saveImages(...args);
			await options.beforeImageNotice?.();
			return notice;
		},
	);
	cleanup.push(async () => {
		fetchSpy.mockRestore();
		saveImagesSpy.mockRestore();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, mock, fetchSpy };
}

function expectSavedImageBeforeSkill(messages: { role: string; content: unknown }[]) {
	const notice = messages.findIndex(
		message =>
			message.role === "developer" &&
			JSON.stringify(message.content).includes("current model does not support image input"),
	);
	const prompt = messages.findIndex(
		message => message.role === "user" && JSON.stringify(message.content).includes("Expanded skill."),
	);
	expect(notice).toBeGreaterThanOrEqual(0);
	expect(JSON.stringify(messages[notice]?.content)).toContain("local://image-");
	expect(prompt).toBeGreaterThan(notice);
}

it("preserves a pasted image in an idle user-invoked skill before the current model call", async () => {
	const { session, mock, fetchSpy } = setup();
	await session.promptCustomMessage(skill);
	expect(fetchSpy).not.toHaveBeenCalled();
	expectSavedImageBeforeSkill(mock.calls[0]?.context.messages ?? []);
});

it("preserves a queued user-invoked skill image before delivery", async () => {
	const { session, mock, fetchSpy } = setup();
	await session.promptCustomMessage(skill, { streamingBehavior: "followUp", queueOnly: true });
	await session.prompt("kickoff");
	await session.waitForIdle();
	expect(fetchSpy).not.toHaveBeenCalled();
	const skillRequest = mock.calls.find(call =>
		call.context.messages.some(message => JSON.stringify(message.content).includes("Expanded skill.")),
	);
	expectSavedImageBeforeSkill(skillRequest?.context.messages ?? []);
});

it("queues an image-bearing skill when another turn starts while its image notice is being prepared", async () => {
	const imagePrepared = Promise.withResolvers<void>();
	const releaseImage = Promise.withResolvers<void>();
	const otherStarted = Promise.withResolvers<void>();
	const releaseOther = Promise.withResolvers<void>();
	const { session, mock, fetchSpy } = setup({
		beforeImageNotice: async () => {
			imagePrepared.resolve();
			await releaseImage.promise;
		},
		responses: [
			async () => {
				otherStarted.resolve();
				await releaseOther.promise;
				return { content: ["other done"] };
			},
		],
	});
	const skillDispatch = session.promptCustomMessage(skill, { streamingBehavior: "followUp" });
	await imagePrepared.promise;
	const otherTurn = session.prompt("other turn");
	await otherStarted.promise;
	releaseImage.resolve();
	// Queued into the running turn, the skill settles while that turn is still blocked;
	// dispatching it as its own turn would wait for the other turn and never settle here.
	await skillDispatch;
	expect(session.agent.state.isStreaming).toBe(true);
	releaseOther.resolve();
	await otherTurn;
	await session.waitForIdle();
	expect(fetchSpy).not.toHaveBeenCalled();
	const skillRequest = mock.calls.find(call =>
		call.context.messages.some(message => JSON.stringify(message.content).includes("Expanded skill.")),
	);
	expect(JSON.stringify(skillRequest?.context.messages)).toContain("other turn");
	expectSavedImageBeforeSkill(skillRequest?.context.messages ?? []);
});

it("drops an image-bearing skill when aborted while its image notice is being prepared", async () => {
	const imagePrepared = Promise.withResolvers<void>();
	const releaseImage = Promise.withResolvers<void>();
	const { session, mock, fetchSpy } = setup({
		beforeImageNotice: async () => {
			imagePrepared.resolve();
			await releaseImage.promise;
		},
	});
	const skillDispatch = session.promptCustomMessage(skill);
	await imagePrepared.promise;
	await session.abort();
	releaseImage.resolve();
	await skillDispatch;
	await session.waitForIdle();
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(mock.calls.length).toBe(0);
	expect(session.messages.length).toBe(0);
});
