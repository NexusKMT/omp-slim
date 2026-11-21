export function makeAssistantMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "openai-completions" as const,
		provider: "anthropic" as const,
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}
