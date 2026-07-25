import { describe, expect, test } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { minimaxCodeCnUsageProvider, minimaxCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/minimax-code";

const INTERVAL_START = 1_785_009_600_000;
const INTERVAL_END = 1_785_024_000_000;
const WEEKLY_START = 1_784_505_600_000;
const WEEKLY_END = 1_785_110_400_000;

function params(provider: "minimax-code" | "minimax-code-cn", apiKey = "sk-cp-test"): UsageFetchParams {
	return { provider, credential: { type: "api_key", apiKey }, accountKey: "account-1" };
}

function remainsPayload() {
	return {
		model_remains: [
			{
				model_name: "general",
				start_time: INTERVAL_START,
				end_time: INTERVAL_END,
				current_interval_total_count: 0,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: 90,
				weekly_start_time: WEEKLY_START,
				weekly_end_time: WEEKLY_END,
				current_weekly_total_count: 0,
				current_weekly_usage_count: 0,
				current_weekly_remaining_percent: 78,
			},
			{
				model_name: "video",
				start_time: INTERVAL_END - 86_400_000,
				end_time: INTERVAL_END,
				current_interval_total_count: 3,
				current_interval_usage_count: 1,
				current_interval_remaining_percent: 100,
				weekly_start_time: WEEKLY_START,
				weekly_end_time: WEEKLY_END,
				current_weekly_total_count: 21,
				current_weekly_usage_count: 1,
				current_weekly_remaining_percent: 100,
			},
		],
		base_resp: { status_code: 0, status_msg: "success" },
	};
}

describe("MiniMax Token Plan usage", () => {
	test("maps each quota bucket to its rolling and weekly windows", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			return Promise.resolve(Response.json(remainsPayload()));
		};

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.minimax.io/v1/token_plan/remains");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer sk-cp-test");
		expect(report?.provider).toBe("minimax-code");
		expect(report?.metadata).toMatchObject({ source: "minimax-token-plan", models: ["general", "video"] });
		expect(report?.limits.map(limit => limit.id)).toEqual(["general:4h", "general:7d", "video:24h", "video:7d"]);

		const [intervalLimit, weeklyLimit, videoInterval, videoWeekly] = report?.limits ?? [];
		expect(intervalLimit?.label).toBe("General 4 Hour");
		expect(intervalLimit?.window).toEqual({
			id: "4h",
			label: "4 Hour",
			durationMs: 14_400_000,
			resetsAt: INTERVAL_END,
		});
		expect(intervalLimit?.amount).toEqual({
			used: 10,
			usedFraction: 0.1,
			remaining: 90,
			remainingFraction: 0.9,
			unit: "percent",
		});
		expect(intervalLimit?.status).toBe("ok");
		expect(intervalLimit?.notes).toBeUndefined();

		expect(weeklyLimit?.window).toEqual({ id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: WEEKLY_END });
		expect(weeklyLimit?.amount).toEqual({
			used: 22,
			usedFraction: 0.22,
			remaining: 78,
			remainingFraction: 0.78,
			unit: "percent",
		});

		expect(videoInterval?.label).toBe("Video 24 Hour");
		expect(videoInterval?.amount.usedFraction).toBe(0);
		expect(videoInterval?.notes).toEqual(["Requests: 1/3"]);
		expect(videoWeekly?.notes).toEqual(["Requests: 1/21"]);
	});

	test("routes the China provider to the mainland endpoint", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = input => {
			requestedUrl = String(input);
			return Promise.resolve(Response.json(remainsPayload()));
		};

		const report = await minimaxCodeCnUsageProvider.fetchUsage(params("minimax-code-cn"), { fetch: fetchMock });

		expect(requestedUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains");
		expect(report?.provider).toBe("minimax-code-cn");
	});

	test("fails closed when MiniMax rejects the key inside a 200 response", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				Response.json({
					base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" },
				}),
			);

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("does not fetch without an API key credential", async () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json(remainsPayload()));
		};
		const request: UsageFetchParams = { provider: "minimax-code", credential: { type: "oauth" } };

		expect(minimaxCodeUsageProvider.supports?.(request)).toBe(false);
		expect(await minimaxCodeUsageProvider.fetchUsage(request, { fetch: fetchMock })).toBeNull();
		expect(fetched).toBe(false);
	});

	test("marks a spent window exhausted and drops buckets with no percentage", async () => {
		const payload = remainsPayload();
		payload.model_remains[0].current_interval_remaining_percent = 0;
		payload.model_remains[1].current_interval_remaining_percent = undefined as unknown as number;
		payload.model_remains[1].current_weekly_remaining_percent = undefined as unknown as number;
		const fetchMock: FetchImpl = () => Promise.resolve(Response.json(payload));

		const report = await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock });

		expect(report?.limits.map(limit => limit.id)).toEqual(["general:4h", "general:7d"]);
		expect(report?.limits[0]?.status).toBe("exhausted");
		expect(report?.limits[0]?.amount.usedFraction).toBe(1);
	});

	test("returns null when the plan reports no quota buckets", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json({ model_remains: [], base_resp: { status_code: 0 } }));

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("rejects a payload with no base_resp envelope", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(Response.json({ model_remains: remainsPayload().model_remains }));

		expect(await minimaxCodeUsageProvider.fetchUsage(params("minimax-code"), { fetch: fetchMock })).toBeNull();
	});

	test("registers both Token Plan ids in AuthStorage's default usage resolver", async () => {
		const store: AuthCredentialStore = {
			close() {},
			listAuthCredentials() {
				return [];
			},
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return false;
			},
			replaceAuthCredentialsForProvider() {
				return [];
			},
			upsertAuthCredentialForProvider() {
				return [];
			},
			deleteAuthCredentialsForProvider() {},
			getCache() {
				return null;
			},
			setCache() {},
			cleanExpiredCache() {},
		};
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			expect(storage.usageProviderFor("minimax-code")).toBe(minimaxCodeUsageProvider);
			expect(storage.usageProviderFor("minimax-code-cn")).toBe(minimaxCodeCnUsageProvider);
		} finally {
			storage.close();
		}
	});
});
