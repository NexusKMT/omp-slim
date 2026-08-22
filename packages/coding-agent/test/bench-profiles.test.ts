import { describe, expect, it } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { type BenchModelRegistry, runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";

const model = {
	provider: "acme",
	id: "bench-model",
	name: "bench-model",
	api: "openai-completions",
	maxTokens: 4096,
	contextWindow: 128_000,
} as unknown as Model<Api>;

const registry: BenchModelRegistry = {
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "sk-test",
	resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
};

interface CapturedRequest {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const events = [
		{ type: "text_delta", delta: "hi" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function message(overrides: { ttft?: number; duration?: number; input?: number; output?: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		stopReason: "stop",
		usage: { input: overrides.input ?? 5, output: overrides.output ?? 20 },
		duration: overrides.duration ?? 120,
		ttft: overrides.ttft ?? 30,
	} as unknown as AssistantMessage;
}

async function runProfiled(flags: Record<string, unknown>, messages?: AssistantMessage[]) {
	const captured: CapturedRequest[] = [];
	let call = 0;
	let session = 0;
	const summary = await runBenchCommand(
		{ models: ["acme/bench-model"], flags: { json: true, ...flags } },
		{
			createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
			randomSessionId: () => `sess-${session++}`,
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, context, options) => {
				captured.push({ context, options });
				const msg = messages?.[Math.min(call, messages.length - 1)] ?? message({});
				call++;
				return streamOf(msg);
			},
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { summary, captured };
}

describe("bench run metrics", () => {
	it("splits prefill and decode windows and derives per-window throughput", async () => {
		// ttft 30ms, total 120ms → 90ms decode; 20 output tokens, 5 input tokens.
		const { summary } = await runProfiled({ runs: 1, par: 1 });
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.ttftMs).toBe(30);
		expect(run.generationMs).toBe(90);
		expect(run.inputTokens).toBe(5);
		expect(run.tokensPerSecond).toBeCloseTo(166.67, 1);
		expect(run.generationTps).toBeCloseTo(222.22, 1);
		expect(run.prefillTps).toBeCloseTo(166.67, 1);
	});

	it("aggregates nearest-rank percentiles over successful runs", async () => {
		const durations = [100, 200, 300, 400, 500];
		const { summary } = await runProfiled(
			{ runs: 5, par: 1 },
			durations.map(duration => message({ duration })),
		);
		const stats = summary.models[0].stats;
		expect(stats).not.toBeNull();
		if (!stats) return;
		expect(stats.durationMs.min).toBe(100);
		expect(stats.durationMs.p50).toBe(300);
		expect(stats.durationMs.p95).toBe(500);
		expect(stats.durationMs.max).toBe(500);
		expect(stats.durationMs.mean).toBe(300);
	});
});

describe("bench profiles", () => {
	it("defaults to the chat profile", async () => {
		const { summary, captured } = await runProfiled({ runs: 1, par: 1 });
		expect(summary.profile).toBe("chat");
		expect(captured[0].options?.maxTokens).toBe(512);
	});

	it("prefill sends a large input with a unique cache-busting nonce per run", async () => {
		const { summary, captured } = await runProfiled({ profile: "prefill", runs: 2, par: 1 });
		expect(summary.profile).toBe("prefill");
		expect(captured).toHaveLength(2);
		const bodies = captured.map(request => {
			const first = request.context.messages[0];
			expect(request.context.messages).toHaveLength(1);
			return typeof first.content === "string" ? first.content : "";
		});
		for (const body of bodies) {
			expect(body).toMatch(/^Benchmark run sess-\d+\./);
			expect(body.length).toBeGreaterThan(32_000);
		}
		// Distinct leading bytes per run: provider prefix caches can never reuse
		// an earlier run's prefill.
		expect(bodies[0].split("\n")[0]).not.toBe(bodies[1].split("\n")[0]);
		expect(captured[0].options?.maxTokens).toBe(64);
	});

	it("prefill honors --prefill-bytes for the synthetic input size", async () => {
		const { captured } = await runProfiled({ profile: "prefill", prefillBytes: 4096, runs: 1, par: 1 });
		const body = captured[0].context.messages[0];
		const text = typeof body.content === "string" ? body.content : "";
		expect(text.length).toBeGreaterThan(4000);
		expect(text.length).toBeLessThan(8192);
	});

	it("generation raises the output budget to force sustained decode", async () => {
		const { summary, captured } = await runProfiled({ profile: "generation", runs: 1, par: 1 });
		expect(summary.profile).toBe("generation");
		expect(captured[0].options?.maxTokens).toBe(2048);
	});

	it("rejects --profile combined with --cache", async () => {
		await expect(runProfiled({ profile: "generation", cache: true })).rejects.toThrow("--cache");
	});

	it("rejects --prefill-bytes without the prefill profile", async () => {
		await expect(runProfiled({ prefillBytes: 1024 })).rejects.toThrow("--prefill-bytes");
	});
});
