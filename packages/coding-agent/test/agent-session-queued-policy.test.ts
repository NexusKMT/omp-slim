import { afterEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BeforeAgentStartEvent, Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const BASE = ["base identity", "base tools"];

function extension(name: string, handler: (event: BeforeAgentStartEvent) => Promise<unknown>): Extension {
	return {
		path: name,
		resolvedPath: name,
		handlers: new Map([
			["before_agent_start", [async (...args: unknown[]) => handler(args[0] as BeforeAgentStartEvent)]],
		]),
		tools: new Map(),
		assistantThinkingRenderers: [],
		assistantTextRenderers: [],
		transcriptPresenters: [],
		linkSchemes: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

describe("queued user delivery policy", () => {
	let session: AgentSession;
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		await session?.dispose();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
		vi.restoreAllMocks();
	});

	function setup(
		responses: MockResponseSource = Array.from({ length: 8 }, () => ({ content: ["done"] })),
		rebuildSystemPrompt?: AgentSessionConfig["rebuildSystemPrompt"],
		options: { settings?: Settings; tools?: AgentTool[]; policy?: boolean } = {},
	) {
		const mock = createMockModel({ responses });
		const requests: Context[] = [];
		const events: BeforeAgentStartEvent[] = [];
		const delivered: AgentMessage[] = [];
		const manager = SessionManager.inMemory();
		// Only credential lookup is needed; requests use the local scripted provider.
		const registry = { getApiKey: async () => "test-key" } as unknown as ModelRegistry;
		let beforePrepare: (() => Promise<void>) | undefined;
		const extensions = [
			extension("policy", async event => {
				events.push(structuredClone(event));
				await beforePrepare?.();
				if (options.policy === false) return undefined;
				const mode = manager
					.getBranch()
					.findLast(entry => entry.type === "custom" && entry.customType === "policy-mode");
				const data = mode?.type === "custom" ? mode.data : undefined;
				const enabled = !data || typeof data !== "object" || !("enabled" in data) || data.enabled !== false;
				return {
					systemPrompt: enabled ? [...event.systemPrompt, `policy:${event.prompt}`] : event.systemPrompt,
					message: { customType: "prepared-context", content: `context:${event.prompt}`, display: false },
				};
			}),
			extension("independent", async event =>
				options.policy === false ? undefined : { systemPrompt: [...event.systemPrompt, "independent policy"] },
			),
		];
		const runner = new ExtensionRunner(extensions, new ExtensionRuntime(), manager.getCwd(), manager, registry);
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const agent = new Agent({
			initialState: { model, systemPrompt: BASE, tools: options.tools ?? [], messages: [] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (model, context, options) => {
				requests.push({
					systemPrompt: [...(context.systemPrompt ?? [])],
					messages: structuredClone(context.messages),
					tools: context.tools ? [...context.tools] : undefined,
				});
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			extensionRunner: runner,
			settings: options.settings ?? Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			toolRegistry: new Map(options.tools?.map(tool => [tool.name, tool])),
			builtInToolNames: options.tools?.map(tool => tool.name),
			rebuildSystemPrompt,
		});
		session.subscribe(event => {
			if (event.type === "message_end") delivered.push(event.message);
		});
		return {
			agent,
			requests,
			events,
			delivered,
			manager,
			extensions,
			pausePreparation: (fn: () => Promise<void>) => {
				beforePrepare = fn;
			},
		};
	}

	it("bootstraps a fresh steer and delivers returned context once with separate policy blocks", async () => {
		const { requests, delivered } = setup();
		await session.steer("first queued task");
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:first queued task", "independent policy"],
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "prepared-context"),
		).toMatchObject([{ content: "context:first queued task", attribution: "user" }]);
	});

	it("uses saved policy changes on idle steer and follow-up instead of the prior override", async () => {
		const { requests, manager, events } = setup();
		await session.prompt("original");
		manager.appendCustomEntry("policy-mode", { enabled: false });
		await session.steer("off steer");
		await session.waitForIdle();
		manager.appendCustomEntry("policy-mode", { enabled: true });
		await session.followUp("on follow-up");
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:original", "independent policy"],
			[...BASE, "independent policy"],
			[...BASE, "policy:on follow-up", "independent policy"],
		]);
		expect(events.map(event => event.prompt)).toEqual(["original", "off steer", "on follow-up"]);
	});

	it("refreshes policy for live queued work without preparing tool-free iterations again", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { requests, manager, events } = setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first response"] };
			},
			{ content: ["queued response"] },
		]);
		const prompt = session.prompt("running");
		await started.promise;
		manager.appendCustomEntry("policy-mode", { enabled: false });
		await session.steer("live steer");
		release.resolve();
		await prompt;
		await session.waitForIdle();
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:running", "independent policy"],
			[...BASE, "independent policy"],
		]);
		expect(events.map(event => event.prompt)).toEqual(["running", "live steer"]);
	});

	it("prepares all actual user bodies in a batch and preserves skill identity and companions", async () => {
		const { agent, requests, delivered, events } = setup();
		agent.setSteeringMode("all");
		const companion: AgentMessage = {
			role: "custom",
			customType: "workflow-notice",
			content: "hidden notice",
			display: false,
			attribution: "user",
			timestamp: 1,
		};
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
		};
		const skill: AgentMessage = {
			role: "custom",
			customType: "skill-prompt",
			content: [{ type: "text", text: "expanded " }, { type: "text", text: "skill body" }, image],
			display: true,
			attribution: "user",
			details: { name: "review", args: "focus", __queueChipText: "/skill:review focus" },
			timestamp: 2,
		};
		agent.steer(companion);
		agent.steer(skill);
		await session.steer("second task");
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["expanded skill body\n\nsecond task"]);
		expect(events[0].images).toEqual([image]);
		expect(requests[0].systemPrompt).toEqual([
			...BASE,
			"policy:expanded skill body\n\nsecond task",
			"independent policy",
		]);
		expect(delivered.filter(message => message.role === "custom" && message.customType === "skill-prompt")).toEqual([
			skill,
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "workflow-notice"),
		).toEqual([companion]);
	});

	it("discards policy and returned context on abort while preserving the undelivered steer", async () => {
		const { agent, requests, delivered, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		await session.steer("abort before delivery");
		await started.promise;
		const abort = session.abort();
		release.resolve();
		await abort;
		expect(requests).toEqual([]);
		expect(delivered.filter(message => message.role === "user" || message.role === "custom")).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
		expect(agent.peekSteeringQueue()).toMatchObject([{ content: [{ type: "text", text: "abort before delivery" }] }]);
	});

	it("uses a handler's refreshed base in the same request without an extension override", async () => {
		const { requests, pausePreparation } = setup(
			undefined,
			async () => ({ systemPrompt: [...BASE, "updated tool policy"] }),
			{ policy: false },
		);
		pausePreparation(async () => {
			await session.refreshBaseSystemPrompt();
		});
		await session.steer("first");
		await session.waitForIdle();
		expect(requests[0].systemPrompt).toEqual([...BASE, "updated tool policy"]);
	});

	it("does not re-enter handlers for a semantic no-op base refresh", async () => {
		const { requests, events, pausePreparation } = setup(undefined, async () => ({ systemPrompt: [...BASE] }));
		pausePreparation(async () => {
			await session.refreshBaseSystemPrompt();
		});
		await session.prompt("stable policy");
		expect(events).toHaveLength(1);
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:stable policy", "independent policy"],
		]);
	});

	async function setupToolPolicy() {
		const tools: AgentTool[] = ["old_tool", "new_tool"].map(name => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		}));
		const fixture = setup(undefined, async names => ({ systemPrompt: [...BASE, `tools:${names.join(",")}`] }), {
			tools,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "tools.xdev": false }),
		});
		await session.setActiveToolsByName(["old_tool"]);
		return fixture;
	}

	it("preserves absolute overrides and their downstream chain after a source-base retry", async () => {
		const { requests, extensions, pausePreparation } = await setupToolPolicy();
		// An absolute policy can intentionally mention old/base text. Never infer a patch from it.
		const absolute = "tools:old_tool is a historical example; use only this absolute policy";
		extensions.push(
			extension("absolute", async () => ({ systemPrompt: absolute })),
			extension("after-absolute", async event => ({ systemPrompt: [...event.systemPrompt, "absolute follower"] })),
		);
		pausePreparation(async () => {
			await session.setActiveToolsByName(["new_tool"]);
		});
		await session.steer("absolute policy");
		await session.waitForIdle();
		expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		expect(requests[0].systemPrompt).toEqual([absolute, "absolute follower"]);
	});

	it("retries a base change during returned-image normalization before publishing the request", async () => {
		const { requests, extensions } = await setupToolPolicy();
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
		};
		extensions.push(
			extension("image-context", async () => ({
				message: { customType: "image-context", content: [image], display: false },
			})),
		);
		const normalizeImages = SessionProviderBoundary.prototype.normalizeImagesForModel;
		let changed = false;
		vi.spyOn(SessionProviderBoundary.prototype, "normalizeImagesForModel").mockImplementation(
			async function (this: SessionProviderBoundary, images) {
				const normalized = await normalizeImages.call(this, images);
				if (!changed) {
					changed = true;
					await session.setActiveToolsByName(["new_tool"]);
				}
				return normalized;
			},
		);
		await session.steer("image policy");
		await session.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(requests[0].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		const prompt = requests[0].systemPrompt?.join("\n");
		expect(prompt).toContain("tools:new_tool");
		expect(prompt).not.toContain("tools:old_tool");
		expect(prompt).toContain("policy:image policy");
		expect(
			requests[0].messages.flatMap(message =>
				Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : [],
			),
		).toHaveLength(1);
	});

	it("pauses automatic draining after live queued policy exhaustion until an explicit retry", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools: AgentTool[] = ["old_tool", "new_tool"].map(name => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		}));
		const { agent, requests, delivered, extensions } = setup(
			[
				{ content: ["existing turn"] },
				async () => {
					started.resolve();
					await release.promise;
					return { content: ["running turn"] };
				},
				{ content: ["queued response"] },
				{ content: ["explicit resume response"] },
			],
			async toolNames => ({ systemPrompt: [...BASE, `tools:${toolNames.join(",")}`] }),
			{ tools },
		);
		await session.setActiveToolsByName(["old_tool"]);
		let attempts = 0;
		extensions.push(
			extension("churn", async event => {
				if (event.prompt === "retain original" && ++attempts <= 3) {
					// Stabilize after three changes so the broken scheduler makes a measurable
					// fourth attempt instead of looping forever.
					await session.setActiveToolsByName([attempts % 2 === 1 ? "new_tool" : "old_tool"]);
				}
			}),
		);
		await session.prompt("existing work");
		await session.steer("running work");
		const running = session.waitForIdle();
		try {
			await Promise.race([
				started.promise,
				running.then(() => {
					throw new Error("Scheduled continuation ended before the live queue boundary");
				}),
			]);
			await session.steer("retain original");
		} finally {
			release.resolve();
		}
		await running;
		await session.waitForIdle();

		expect(attempts).toBe(3);
		expect(requests).toHaveLength(2);
		expect(agent.peekSteeringQueue()).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "retain original" }], attribution: "user" },
		]);
		const errors = delivered.filter(message => message.role === "assistant" && message.stopReason === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].role === "assistant" && errors[0].errorMessage).toContain("System prompt changed");
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "prepared-context"),
		).toMatchObject([{ content: "context:existing work" }, { content: "context:running work" }]);

		await session.followUp("resume paused queue");
		await session.waitForIdle();
		expect(attempts).toBe(4);
		expect(requests).toHaveLength(4);
		expect(requests[2].tools?.map(tool => tool.name)).toEqual(["new_tool"]);
		expect(requests[2].systemPrompt).toContain("policy:retain original");
		expect(delivered.filter(message => message.role === "user")).toMatchObject([
			{ content: [{ type: "text", text: "existing work" }] },
			{ content: [{ type: "text", text: "running work" }] },
			{ content: [{ type: "text", text: "retain original" }] },
			{ content: [{ type: "text", text: "resume paused queue" }] },
		]);
		expect(delivered.filter(message => message.role === "assistant" && message.stopReason === "error")).toHaveLength(
			1,
		);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("does not commit an ordinary prompt's stale policy after abort during preparation", async () => {
		const { requests, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		const prompt = session.prompt("cancel ordinary");
		await started.promise;
		const abort = session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(requests).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
	});

	it("does not leak a pending queue preparation into a new session", async () => {
		const { agent, requests, pausePreparation } = setup();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pausePreparation(async () => {
			started.resolve();
			await release.promise;
		});
		await session.steer("old session");
		await started.promise;
		const transition = session.newSession();
		release.resolve();
		await transition;
		expect(requests).toEqual([]);
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(session.systemPrompt).toEqual(BASE);
		pausePreparation(async () => {});
		await session.prompt("new session");
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:new session", "independent policy"],
		]);
	});

	it("prepares a steer after a running tool settles, not on subsequent tool iterations", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { agent, requests, events, delivered } = setup([
			{ content: [{ type: "toolCall", name: "work", arguments: {} }] },
			{ content: [{ type: "toolCall", name: "work", arguments: {} }] },
			{ content: ["finished"] },
		]);
		let calls = 0;
		agent.setTools([
			{
				name: "work",
				label: "work",
				description: "Do local work",
				parameters: Type.Object({}),
				execute: async () => {
					if (calls++ === 0) {
						started.resolve();
						await release.promise;
					}
					return { content: [{ type: "text", text: "work completed" }], details: {} };
				},
			},
		]);
		const prompt = session.prompt("initial work");
		await Promise.race([
			started.promise,
			prompt.then(() => {
				throw new Error("Run ended before the tool boundary");
			}),
		]);
		await session.steer("changed work");
		release.resolve();
		await prompt;
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["initial work", "changed work"]);
		expect(requests.map(request => request.systemPrompt)).toEqual([
			[...BASE, "policy:initial work", "independent policy"],
			[...BASE, "policy:changed work", "independent policy"],
			[...BASE, "policy:changed work", "independent policy"],
		]);
		expect(
			delivered.filter(message => message.role === "custom" && message.customType === "prepared-context"),
		).toMatchObject([{ content: "context:initial work" }, { content: "context:changed work" }]);
	});

	it("does not add policy preparation to synthetic-only queue continuations", async () => {
		const { requests, events } = setup();
		await session.prompt("user task");
		await session.followUp("internal continuation", undefined, { synthetic: true });
		await session.waitForIdle();
		expect(events.map(event => event.prompt)).toEqual(["user task"]);
		expect(requests).toHaveLength(2);
		expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
	});

	it.each(["steering", "followUp"] as const)(
		"withdraws %s input already dequeued for the next model call when interrupted",
		async queue => {
			const { agent, delivered } = setup();
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "AAAA" };
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let calls = 0;
			// The first model call queues the input; the run dequeues it once that call ends and
			// holds the next call here, before the transcript records it.
			const removeGate = agent.addBeforeModelCallHook(async () => {
				if (calls++ === 0) {
					if (queue === "steering") await session.steer("dequeued input", [image]);
					else await session.followUp("dequeued input", [image]);
					return;
				}
				reached.resolve();
				await release.promise;
			});
			const ends: AgentMessage[][] = [];
			session.subscribe(event => {
				if (event.type === "agent_end") ends.push(event.messages);
			});
			const run = session.prompt("first task");
			await reached.promise;
			expect([...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue()]).toEqual([]);
			if (queue === "steering") await session.steer("queued after", [image]);
			else await session.followUp("queued after", [image]);

			const restored = session.clearQueue({ forInterrupt: true });
			const abort = session.abort();
			release.resolve();
			await abort;
			await run;
			removeGate();

			// Neither the aborted turn nor a requeue records it or its prepared context, and the
			// run's agent_end does not report it either.
			expect(ends).not.toEqual([]);
			expect(
				[...delivered, ...ends.flat()].filter(message =>
					/dequeued input|queued after/.test(JSON.stringify(message)),
				),
			).toEqual([]);
			// The input dequeued first is restored first.
			expect(restored).toEqual({
				steering: [],
				followUp: [],
				[queue]: [
					{ text: "dequeued input", images: [image] },
					{ text: "queued after", images: [image] },
				],
			});
			expect(agent.hasQueuedMessages()).toBe(false);
			expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		},
	);

	it("withdraws dequeued steering and follow-up into their own queues when interrupted", async () => {
		const { agent, delivered } = setup();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const removeGate = agent.addBeforeModelCallHook(async () => {
			if (calls++ === 0) return;
			reached.resolve();
			await release.promise;
		});
		// Queued as the first response yields, so the yield-point drain dequeues both together for
		// the next model call.
		agent.setOnBeforeYield(async () => {
			agent.setOnBeforeYield(undefined);
			await session.steer("dequeued steer");
			await session.followUp("dequeued follow-up");
		});
		const run = session.prompt("first task");
		await reached.promise;
		expect([...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue()]).toEqual([]);

		const restored = session.clearQueue({ forInterrupt: true });
		const abort = session.abort();
		release.resolve();
		await abort;
		await run;
		removeGate();

		expect(delivered.filter(message => JSON.stringify(message).includes("dequeued"))).toEqual([]);
		expect(restored).toEqual({
			steering: [{ text: "dequeued steer" }],
			followUp: [{ text: "dequeued follow-up" }],
		});
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("leaves input dequeued for the next model call to the continuing run on a plain queue clear", async () => {
		const { agent, delivered } = setup();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const removeGate = agent.addBeforeModelCallHook(async () => {
			if (calls++ === 0) {
				await session.steer("dequeued input");
				return;
			}
			if (calls === 2) reached.resolve();
			await release.promise;
		});
		const run = session.prompt("first task");
		await reached.promise;

		// Alt+Up only takes back what is still queued; the run keeps the batch it already took.
		expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
		release.resolve();
		await run;
		removeGate();

		expect(delivered.filter(message => message.role === "user").map(message => JSON.stringify(message))).toEqual([
			expect.stringContaining("first task"),
			expect.stringContaining("dequeued input"),
		]);
	});
});
