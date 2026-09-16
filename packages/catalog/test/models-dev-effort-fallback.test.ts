/**
 * Contract: a discovered reasoning model whose effort tiers no rule declares
 * adopts the ladder the catalog publishes for its id, while rule-owned ladders
 * and non-reasoning rows stay exactly as they are.
 *
 * Moonshot is the fixture because its mapper marks any `-thinking` variant as
 * reasoning, so an id omp does not recognize still arrives as a reasoning
 * model with no ladder of its own.
 */
import { beforeEach, expect, test } from "bun:test";
import { hasModelScopedEffortLadder, resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	expirePublishedEffortLaddersForTest,
	moonshotModelManagerOptions,
	resetPublishedEffortLaddersForTest,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const SHARED_CATALOG_URL = "https://catalog.stencil.so/models.json.zstd";
const MODELS_DEV_URL = "https://models.dev/api.json";
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_MODELS_URL = `${MOONSHOT_BASE_URL}/models`;

/** No rule declares this id's tiers: its ladder is the neutral wire default. */
const UNREVIEWED_ID = "nebula-9b-thinking";
/** A rule-owned identity: reviewed KDL declares this model's tiers. */
const REVIEWED_ID = "kimi-k3";

function catalogRow(ladder?: string[]): Record<string, unknown> {
	return {
		tool_call: true,
		reasoning: true,
		modalities: { input: ["text"] },
		limit: { context: 131_072, output: 32_768 },
		cost: { input: 1, output: 2 },
		...(ladder && { reasoning_options: [{ type: "effort", values: ladder }] }),
	};
}

function stubFetch(routes: Record<string, unknown>, calls: string[], modelIds: string[]): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url.startsWith(MOONSHOT_MODELS_URL)) {
			return Response.json({ data: modelIds.map(id => ({ id, object: "model" })) });
		}
		const payload = routes[url];
		return payload === undefined ? new Response("not found", { status: 404 }) : Response.json(payload);
	}) as FetchImpl;
}

function discover(fetchImpl: FetchImpl): Promise<readonly ModelSpec<"openai-completions">[] | null | undefined> {
	return Promise.resolve(
		moonshotModelManagerOptions({
			apiKey: "moonshot-test-key",
			baseUrl: MOONSHOT_BASE_URL,
			fetch: fetchImpl,
		}).fetchDynamicModels?.(),
	);
}

beforeEach(() => {
	resetPublishedEffortLaddersForTest();
});

test("the neutral default and a rule-owned ladder are distinguishable", () => {
	const spec = {
		id: UNREVIEWED_ID,
		name: UNREVIEWED_ID,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: MOONSHOT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">;

	expect(hasModelScopedEffortLadder(spec)).toBe(false);
	expect(hasModelScopedEffortLadder({ ...spec, id: REVIEWED_ID })).toBe(true);
});

test("published tiers replace the guess, read from the shared catalog when it has them", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high", "max"]) } } } },
			calls,
			[UNREVIEWED_ID],
		),
	);
	const model = models?.find(candidate => candidate.id === UNREVIEWED_ID);

	expect(model?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	// The guess it replaced, so the assertion above cannot pass by accident.
	expect(resolveModelPolicy({ ...model!, thinking: undefined }).thinking?.efforts).not.toEqual([
		Effort.Low,
		Effort.High,
		Effort.Max,
	]);
	// models.dev itself stays untouched while the shared payload carries tiers.
	expect(calls).not.toContain(MODELS_DEV_URL);
});

test("falls back to models.dev when the shared catalog publishes no tiers at all, peeling gateway prefixes", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow() } } },
				[MODELS_DEV_URL]: { acme: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } },
			},
			calls,
			[`acme/${UNREVIEWED_ID}`],
		),
	);

	expect(calls).toContain(MODELS_DEV_URL);
	expect(models?.find(candidate => candidate.id === `acme/${UNREVIEWED_ID}`)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
});

test("rule-owned ladders and non-reasoning rows are left alone", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					moonshotai: {
						models: {
							[REVIEWED_ID]: catalogRow(["minimal"]),
							"plain-chat-9b": catalogRow(["low", "high"]),
						},
					},
				},
			},
			calls,
			[REVIEWED_ID, "plain-chat-9b"],
		),
	);
	const reviewed = models?.find(candidate => candidate.id === REVIEWED_ID);
	const plain = models?.find(candidate => candidate.id === "plain-chat-9b");

	// The catalog publishes a narrower ["minimal"]; the reviewed tiers survive.
	expect(reviewed?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	expect(resolveModelPolicy(reviewed!).thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	// Discovery says this one does not reason; a published ladder cannot flip that.
	expect(plain?.reasoning).toBe(false);
	expect(plain?.thinking).toBeUndefined();
});

test("no catalog request when every discovered model's tiers are already known", async () => {
	const calls: string[] = [];
	const models = await discover(stubFetch({}, calls, [REVIEWED_ID]));

	expect(models?.map(model => model.id)).toEqual([REVIEWED_ID]);
	expect(calls).toEqual([MOONSHOT_MODELS_URL]);
});

test("an unreachable catalog, or one that knows nothing about the id, leaves the guess in place", async () => {
	const calls: string[] = [];
	const models = await discover(stubFetch({}, calls, [UNREVIEWED_ID]));

	expect(calls).toContain(SHARED_CATALOG_URL);
	expect(calls).toContain(MODELS_DEV_URL);
	expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
});

test("a duplicated id takes the ladder its own host published", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					// Listed first, so a bare-id index would hand this ladder to Moonshot.
					acme: { models: { [UNREVIEWED_ID]: catalogRow(["minimal", "low"]) } },
					moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high", "max"]) } },
				},
			},
			calls,
			[UNREVIEWED_ID],
		),
	);

	expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High, Effort.Max],
	});
});

test("an id foreign hosts publish differently stays unknown; hosts that agree still answer", async () => {
	const calls: string[] = [];
	const agreedId = "quasar-7b-thinking";
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					acme: {
						models: {
							[UNREVIEWED_ID]: catalogRow(["minimal", "low"]),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
					zeta: {
						models: {
							[UNREVIEWED_ID]: catalogRow(["low", "high", "max"]),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
				},
			},
			calls,
			[UNREVIEWED_ID, agreedId],
		),
	);

	// Neither host is Moonshot's and they disagree: offering either could name a
	// tier this endpoint rejects, so the ladder stays the neutral guess.
	expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
	expect(models?.find(candidate => candidate.id === agreedId)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
});

test("concurrent discovery refreshes share one catalog request", async () => {
	const calls: string[] = [];
	const fetchImpl = stubFetch(
		{
			[SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow() } } },
			[MODELS_DEV_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } },
		},
		calls,
		[UNREVIEWED_ID],
	);

	const refreshes = await Promise.all([discover(fetchImpl), discover(fetchImpl)]);

	expect(calls.filter(url => url === MODELS_DEV_URL)).toHaveLength(1);
	expect(calls.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
	for (const models of refreshes) {
		expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
		});
	}
});
test("isolates published ladders and in-flight requests by fetch implementation", async () => {
	const callsA: string[] = [];
	const callsB: string[] = [];
	const fetchA = stubFetch(
		{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low"]) } } } },
		callsA,
		[UNREVIEWED_ID],
	);
	const fetchB = stubFetch(
		{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["high"]) } } } },
		callsB,
		[UNREVIEWED_ID],
	);
	const [modelsA, modelsB] = await Promise.all([discover(fetchA), discover(fetchB)]);
	expect(modelsA?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low],
	});
	expect(modelsB?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.High],
	});
	expect(callsA.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
	expect(callsB.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
});

test("a host row without an effort ladder blocks a foreign bare-id ladder", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					acme: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } },
					moonshotai: { models: { [UNREVIEWED_ID]: catalogRow() } },
				},
			},
			calls,
			[UNREVIEWED_ID],
		),
	);
	expect(models?.find(model => model.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
	expect(calls).not.toContain(MODELS_DEV_URL);
});

test("retains a good ladder when the post-TTL fallback fetch fails", async () => {
	const calls: string[] = [];
	const routes: Record<string, unknown> = {
		[SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow() } } },
		[MODELS_DEV_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } },
	};
	const fetchImpl = stubFetch(routes, calls, [UNREVIEWED_ID]);
	const first = await discover(fetchImpl);
	expect(first?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
	expirePublishedEffortLaddersForTest(fetchImpl);
	routes[MODELS_DEV_URL] = undefined;
	const second = await discover(fetchImpl);
	expect(second?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
	expect(calls.filter(url => url === MODELS_DEV_URL)).toHaveLength(2);
});
