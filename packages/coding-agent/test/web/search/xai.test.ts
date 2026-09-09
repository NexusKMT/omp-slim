import { describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchXAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";

const fakeAuthStorage = {
	resolver: vi.fn(() => async () => "test-key"),
	getCredentialOrigin: vi.fn(() => undefined),
	hasAuth: vi.fn(() => true),
} as unknown as AuthStorage;

function makeFetchMock(response: Record<string, unknown>): FetchImpl {
	return async () =>
		new Response(JSON.stringify(response), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
}

function makeParams(fetch: FetchImpl, extras: Record<string, unknown> = {}) {
	return {
		query: "Bun latest release",
		systemPrompt: "xAI integration test prompt",
		authStorage: fakeAuthStorage,
		fetch,
		...extras,
	};
}

describe("xAI Responses answer extraction from relay output items", () => {
	it("drops between-call narration and keeps the final substantive message", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest Bun release." }] },
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://bun.com/blog/bun-v1-3-12", title: "Bun v1.3.12" }] },
				},
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};
		const fetch = makeFetchMock(relayResponse);

		const response = await searchXAI(makeParams(fetch));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("keeps an earlier message that carries citations and drops its narration", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll check the changelog." }] },
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "The Bun changelog records the 1.3.12 patch.",
							annotations: [
								{
									type: "url_citation",
									url: "https://bun.com/blog/bun-v1-3-12",
									title: "Bun v1.3.12",
								},
							],
						},
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Summarizing now." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The Bun changelog records the 1.3.12 patch.");
		expect(response.answer).toContain("Summarizing now.");
		expect(response.answer).not.toContain("I'll check the changelog.");
	});

	it("keeps a long substantive earlier message and drops surrounding narration", async () => {
		const longText = "A".repeat(400);
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Let me search for this." }] },
				{ type: "message", content: [{ type: "output_text", text: longText }] },
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(longText);
		expect(response.answer).toContain("Done.");
		expect(response.answer).not.toContain("Let me search for this.");
	});

	it("keeps an earlier message at exactly the narration threshold and drops one below it", async () => {
		const atThreshold = "B".repeat(300);
		const belowThreshold = "C".repeat(299);
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: atThreshold }] },
				{ type: "message", content: [{ type: "output_text", text: belowThreshold }] },
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(atThreshold);
		expect(response.answer).not.toContain(belowThreshold);
		expect(response.answer).toContain("Done.");
	});

	it("measures the threshold on a message's combined parts without separators, not per part", async () => {
		const part1 = "D".repeat(160);
		const part2 = "E".repeat(140); // 160 + 140 = 300 exactly, no separator counted
		const below = "F".repeat(150); // 150 + 149 = 299, one short
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Searching the release notes." }] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: part1 },
						{ type: "output_text", text: part2 },
					],
				},
				{
					type: "message",
					content: [
						{ type: "output_text", text: below },
						{ type: "output_text", text: "G".repeat(149) },
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(part2);
		expect(response.answer).toContain("Done.");
		expect(response.answer).not.toContain("F".repeat(150));
		expect(response.answer).not.toContain("Searching the release notes.");
	});

	it("ignores text on non-message output items", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("treats an untyped output item as a message, not as ignorable", async () => {
		// Relays may omit the output item's `type`; a valid content array on
		// an untyped item still contributes to the answer (matches the
		// pre-filter fallback contract), while explicit non-message types
		// like `reasoning` stay ignored.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("treats message-level url_citation annotations as substance", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					annotations: [
						{
							type: "url_citation",
							url: "https://bun.com/blog/bun-v1-3-12",
							title: "Bun v1.3.12",
						},
					],
					content: [{ type: "output_text", text: "The Bun changelog records the 1.3.12 patch." }],
				},
				{ type: "message", content: [{ type: "output_text", text: "Summarizing now." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The Bun changelog records the 1.3.12 patch.");
		expect(response.answer).toContain("Summarizing now.");
	});

	it("yields no answer when the last message is empty instead of promoting earlier text", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "A".repeat(400) }] },
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest release." }] },
				{ type: "message", content: [] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		let thrown: unknown;
		try {
			await searchXAI(makeParams(makeFetchMock(relayResponse)));
		} catch (err) {
			thrown = err;
		}

		expect(String(thrown)).toContain("no answer or sources");
	});

	it("keeps every part of the final message, not just its last part", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest Bun release." }] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: "The answer is Bun 1.3.12." },
						{ type: "output_text", text: "See the blog post for details." },
					],
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The answer is Bun 1.3.12.");
		expect(response.answer).toContain("See the blog post for details.");
		expect(response.answer).not.toContain("I'll search for the latest Bun release.");
	});

	it("does not treat non-citation annotations as evidence of substance", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Checking the changelog now.",
							annotations: [{ type: "other_metadata", payload: "relay-internal" }],
						},
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});
});
