import { isCatalogEndpointUrl } from "@oh-my-pi/pi-catalog/compat/catalog-endpoint";
import { logger } from "@oh-my-pi/pi-utils";
import type { Api, FetchImpl, Model } from "../types";
import { lastDispatchOrigin, transportFetch } from "../utils/transport-fetch";
import { resolveAnthropicBaseUrl, resolveAnthropicPrewarmTarget } from "./anthropic-http-options";
import { isAnthropicMessagesModel } from "./transform-messages";

/**
 * Minimum gap between warm-ups of one origin. Idle pooled sockets outlive it
 * by minutes (Copilot drops them after ~2.5–5 min, most hosts later), so a
 * tighter cadence would only add requests.
 */
const PREWARM_INTERVAL_MS = 30_000;
const PREWARM_TIMEOUT_MS = 10_000;
/** A host that has not answered a `HEAD` in this long counts as unreachable. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long one probe answers for its origin; long enough to share between back-to-back callers. */
const PROBE_CACHE_MS = 10_000;

const prewarmedAt = new Map<string, number>();
const probes = new Map<string, { at: number; reachable: Promise<boolean> }>();

/**
 * Where a warm-up for {@link model} goes, or `undefined` when it must not be
 * probed. First-party Anthropic resolves its effective endpoint (following
 * `ANTHROPIC_BASE_URL`/Foundry reroutes) and TLS options up front. Every
 * other model warms only the origin its last inference request actually
 * reached, so credential endpoints (Copilot plans), env overrides
 * (`MOONSHOT_BASE_URL`, `XAI_BASE_URL`), and regional hosts are never guessed
 * from `baseUrl`; before its first request there is nothing to warm. That
 * origin must also be the provider's own endpoint: a custom provider, or a
 * catalog provider id routed to a gateway, proxy, or local server, is never
 * probed.
 */
function resolvePrewarmTarget(model: Model<Api>): { origin: string; init: RequestInit } | undefined {
	if (model.provider === "anthropic") {
		const target = resolveAnthropicPrewarmTarget(model);
		return target && { origin: new URL(target.url).origin, init: target.init };
	}
	const origin = lastDispatchOrigin(model);
	if (!origin || !isCatalogEndpointUrl(model, origin)) return undefined;
	return { origin, init: {} };
}

/**
 * Opens, or keeps alive, a pooled connection to {@link model}'s API host so
 * the next turn skips DNS + TCP + TLS. Sends a credential-less `HEAD` (nothing
 * is billed; hosts answer 401/404/405) through the same transport — proxy,
 * extra CA, Cowork profile, TLS options — as real requests, because sockets
 * pool per transport configuration and a warm-up made any other way (e.g.
 * `fetch.preconnect`, which also throws on Windows) is never reused.
 * Throttled per origin; best effort, never throws.
 */
export async function prewarmModelConnection(model: Model<Api>, options?: { fetch?: FetchImpl }): Promise<void> {
	let origin: string | undefined;
	try {
		// Inside the boundary: resolving Anthropic's TLS options throws on an
		// unusable CA or client-certificate setup, which the real request reports.
		const target = resolvePrewarmTarget(model);
		if (!target) return;
		origin = target.origin;
		const now = Date.now();
		const last = prewarmedAt.get(origin);
		if (last !== undefined && now - last < PREWARM_INTERVAL_MS) return;
		prewarmedAt.set(origin, now);
		const response = await transportFetch(model, options?.fetch)(origin, {
			...target.init,
			method: "HEAD",
			headers: {},
			signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch (error) {
		logger.debug("Model connection prewarm failed", {
			origin,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Where a reachability probe for {@link model} goes. The warm-up target when
 * there is one; otherwise the origin the model last sent to, or its configured
 * base URL. Unlike a warm-up, gateways, custom providers and local servers are
 * probed too: a local server is the one host that still answers offline.
 */
function resolveProbeTarget(model: Model<Api>): { origin: string; init: RequestInit } | undefined {
	const warm = resolvePrewarmTarget(model);
	if (warm) return warm;
	const url =
		lastDispatchOrigin(model) ?? (isAnthropicMessagesModel(model) ? resolveAnthropicBaseUrl(model) : model.baseUrl);
	return url ? { origin: new URL(url).origin, init: {} } : undefined;
}

/**
 * Whether {@link model}'s API host answers at all. Sends a credential-less
 * `HEAD` through the same transport as real requests (proxy, extra CA, TLS
 * options), so it fails exactly when a request would fail to connect. Any
 * HTTP response counts as reachable; a rejected fetch or no answer within
 * {@link PROBE_TIMEOUT_MS} does not. A model with no origin to probe counts as
 * reachable. One probe per origin answers for {@link PROBE_CACHE_MS}.
 */
export function probeModelConnection(model: Model<Api>, options?: { fetch?: FetchImpl }): Promise<boolean> {
	let target: { origin: string; init: RequestInit } | undefined;
	try {
		target = resolveProbeTarget(model);
	} catch {
		target = undefined;
	}
	if (!target) return Promise.resolve(true);
	const { origin, init } = target;
	const now = Date.now();
	const cached = probes.get(origin);
	if (cached && now - cached.at < PROBE_CACHE_MS) return cached.reachable;
	const reachable = (async () => {
		try {
			const response = await transportFetch(model, options?.fetch)(origin, {
				...init,
				method: "HEAD",
				headers: {},
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			await response.body?.cancel();
			return true;
		} catch (error) {
			logger.debug("Model connection probe failed", {
				origin,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	})();
	probes.set(origin, { at: now, reachable });
	return reachable;
}

/** Test hook: forgets every warm-up and probe so the next call is not throttled or cached. */
export function resetConnectionPrewarmForTesting(): void {
	prewarmedAt.clear();
	probes.clear();
}
