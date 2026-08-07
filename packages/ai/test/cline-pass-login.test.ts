import { describe, expect, it } from "bun:test";
import { loginClinePass } from "@oh-my-pi/pi-ai/registry/cline-pass";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("ClinePass login", () => {
	it("opens the dashboard and validates the API key against the subscription chat route", async () => {
		const authUrls: string[] = [];
		let authorization = "";
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		const fetchMock: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ choices: [] });
		};

		const result = await loginClinePass({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk_test  ",
			fetch: fetchMock,
		});

		expect(result).toBe("sk_test");
		expect(authUrls).toEqual(["https://app.cline.bot/dashboard/account"]);
		expect(requestUrl).toBe("https://api.cline.bot/api/v1/chat/completions");
		expect(authorization).toBe("Bearer sk_test");
		expect(requestBody).toEqual({
			model: "cline-pass/kimi-k3",
			messages: [{ role: "user", content: "ping" }],
			max_completion_tokens: 16,
			temperature: 0,
		});
	});
});
