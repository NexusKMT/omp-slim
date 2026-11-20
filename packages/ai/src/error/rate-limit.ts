/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000; // 5s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
const CREDITS_EXHAUSTED_PATTERN =
	/\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;
const PREPAID_BALANCE_EXHAUSTED_PATTERN = /\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b/i;
const SPEND_LIMIT_PATTERN = /spend(?:ing)?[\s_-]?(?:limit|cap)\b/i;
const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
	return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}

// ClinePass subscription-window exhaustion ("clinepass limit …") and free-tier
// model caps ("free limit reached on model … try again in …") are account-local
// quota exhaustion, not per-minute rate limiting.
// gRPC/Connect end-streams carry the status as its name (`resource_exhausted`),
// while HTTP bodies use the phrase ("resource exhausted"). Strip either form
// before classifying explicit details; an otherwise opaque status is transient
// model capacity, while quota/rate-limit/server wording remains authoritative.
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
	// Require an actual cap signal near "concurrent". "Too many concurrent
	// requests" is itself a cap signal; bare feature rejections such as
	// "concurrent invocation is not supported" remain excluded.
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
// Simplified Chinese account-quota exhaustion phrasing. Zhipu Coding Plan
// returns e.g. "429 已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。"
// (type=1308) when the 5h window is spent; MiniMax CN returns
// "当前已达到 Token Plan 用量上限。…" (2067); other CN providers use 额度已用完 /
// 配额已耗尽 / 余额不足. These are persistent account-local caps that must
// rotate to a sibling credential, not transient rate limits, so they are
// matched before the RATE_LIMIT_EXCEEDED branch. The 上限 arm is anchored on
// the 使用 / 用量 tokens: a rate/concurrency cap phrased as 每分钟请求数已达上限 /
// 并发请求数已达上限 / 速率达到上限 (neither token) must NOT match, or it would
// burn a healthy sibling credential as a false quota. "速率限制" is absent for
// the same reason.
const CN_QUOTA_EXHAUSTED_PATTERN =
	/(?:使用|用量).{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
// Simplified Chinese rate/concurrency caps can contain both 使用 and 上限, but
// remain transient rather than account quota exhaustion.
const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
// Common Simplified Chinese throttle phrasing. Consulted by
// isOpaqueStatusBody so CN transients stay in the provider backoff lane instead
// of rotating through the opaque-429 fallback.
const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;
const TPM_RPM_THROTTLE_PATTERN =
	/\b(?:tpm|rpm)\b[^\n]{0,40}\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b|\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b[^\n]{0,40}\b(?:tpm|rpm)\b|\bRateLimitExceeded\.(?:Endpoint)?(?:TPM|RPM)\w*/i;

function isQuotaExhaustedReason(reason: RateLimitReason): boolean {
	return reason === "QUOTA_EXHAUSTED";
}

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: explicit details in a resource-exhausted error > QUOTA
 * (Antigravity "quota will reset") > CN quota > DASHSCOPE_TOKEN_LIMIT (TPM/TPS
 * throttle) > CONCURRENT_LIMIT > MODEL_CAPACITY > QUOTA (account) > RATE_LIMIT
 * (including TPM/RPM rolling windows) > QUOTA (generic) > SERVER_ERROR > bare
 * resource-exhausted > UNKNOWN.
 *
 * Bare "resource exhausted" / "resource_exhausted" maps to MODEL_CAPACITY (transient, short wait).
 * Explicit details such as "quota exceeded" retain their normal classification.
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lowerWithStatus = errorMessage.toLowerCase();
	const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;

	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	// Simplified Chinese quota-exhaustion phrasing (Zhipu Coding Plan and other
	// CN providers). Must precede the MODEL_CAPACITY / RATE_LIMIT branches so an
	// account-local cap rotates instead of backing off as a transient.
	if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) {
		return "CONCURRENT_LIMIT";
	}

	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (matchesSubscriptionCapText(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}
	if (PREPAID_BALANCE_EXHAUSTED_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque") ||
		TPM_RPM_THROTTLE_PATTERN.test(errorMessage)
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		// xAI SuperGrok: HTTP 403 "run out of credits" / spending-limit is an
		// account-local cap — rotate, don't treat as auth failure.
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	if (hasResourceExhaustedStatus) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "CONCURRENT_LIMIT":
			return CONCURRENT_LIMIT_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|out of (?:extra )?usage|spending[- _]?limit/i;

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * HTTP 402 Payment Required represents an account-billing cap (xAI
 * Grok Build "usage balance exhausted", DeepSeek "Insufficient Balance",
 * OpenCode Go "Insufficient account funds", OpenRouter credit exhaustion)
 * when opaque, payment/deactivation/balance/funds-worded, or
 * QUOTA_EXHAUSTED/CONCURRENT_LIMIT. Informative non-quota 402s (e.g.
 * endpoint subscription requirements) remain non-usage-limits. Always combine
 * with {@link isUsageLimitOutcome} when a message is available.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}
const STATUS_402_QUOTA_PATTERN =
	/\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?(?:balance|account.?funds))\b/i;

export function is402BillingCapBody(message: string | undefined): boolean {
	if (message === undefined || isOpaqueStatusBody(message)) return true;
	if (STATUS_402_QUOTA_PATTERN.test(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason) || reason === "CONCURRENT_LIMIT";
}

// Billing-cap wording: the account is out of money the user must add, as
// opposed to a quota window that reopens on a clock. LithosAI answers
// `402 the organization is out of credit, add more to continue
// (type=insufficient_quota …)`; the rest are the same state on other
// providers (DeepSeek "Insufficient Balance", OpenRouter credits, spend
// ceilings, ChatGPT-style "out of credits").
const OUT_OF_CREDIT_PATTERN = /\bout of credit|\badd (?:more )?credit|\btop ?up\b/i;

/**
 * Whether a usage-limit failure is a *billing* cap rather than a window that
 * reopens on a clock: an out-of-credit balance (402), a spent prepaid
 * balance, a credits wall, or a spend ceiling. Topping the account up clears
 * it; waiting never does, so the retry loop must surface the error instead of
 * sleeping the QUOTA_EXHAUSTED heuristic (30 min) — a `retry.maxDelayMs` at
 * or above that heuristic would otherwise hold the session through the whole
 * sleep while the user has no way to retry by hand.
 *
 * A DashScope/Bailian per-minute token throttle and a concurrency cap wear
 * quota wording but are transient slots, so both stay out.
 */
export function isBillingCapUsageLimit(status: number | undefined, message: string | undefined): boolean {
	if (message === undefined) return false;
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (status === 402) return is402BillingCapBody(message);
	return (
		OUT_OF_CREDIT_PATTERN.test(message) ||
		INSUFFICIENT_BALANCE_PATTERN.test(message) ||
		CREDITS_EXHAUSTED_PATTERN.test(message) ||
		PREPAID_BALANCE_EXHAUSTED_PATTERN.test(message) ||
		SPEND_LIMIT_PATTERN.test(message) ||
		/\binsufficient_quota\b/i.test(message)
	);
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches {@link isUsageLimitError} (Codex `usage_limit_reached`,
 *     Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 *     `insufficient_quota`, …) → rotate.
 *  2. Status is not a usage-limit status (429/402) → backoff (caller's domain).
 *  3. Body is absent or {@link isOpaqueStatusBody opaque} (just the status,
 *     empty JSON, HTTP framing only) → rotate conservatively: the server
 *     gave us nothing else to go on.
 *  4. Body has content → defer to {@link parseRateLimitReason}. `QUOTA_EXHAUSTED`
 *     rotates; for a 402 status a `CONCURRENT_LIMIT` body also rotates (the cap
 *     is concurrent-worded but the status is an exhausted billing cap).
 *     `RATE_LIMIT_EXCEEDED` (`Too many requests`, per-minute caps),
 *     `MODEL_CAPACITY_EXHAUSTED` (`Service overloaded`), `SERVER_ERROR`, and
 *     `UNKNOWN` (e.g. "A subscription is required for this endpoint" or
 *     "Please retry in 5s") stay in the provider's own backoff / failure
 *     layer so transient or non-quota responses don't burn sibling credentials.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && matchesUsageLimitText(message)) return true;
	if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
	if (status === 402 && is402BillingCapBody(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason);
}
/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, the status digits with HTTP/JSON
 * framing, or generic punctuation. Anything else (retry hints, capacity
 * wording, error descriptions) is informative enough to defer to the
 * classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "")
		.replace(/\(?\bno body\b\)?/gi, "");
	// A body is informative when the text classifier can act on it. Any Latin
	// word or Simplified Chinese phrasing the classifier recognizes (quota
	// exhaustion or a throttle) defers to parseRateLimitReason; a body that
	// is only status digits / HTTP framing is opaque and rotates conservatively.
	// A Han-only body the classifier cannot interpret (e.g. Japanese Kanji
	// quota text, since Japanese is out of scope) must stay opaque so the
	// opaque-429 fallback still rotates. This keeps the exception scoped to
	// text we actually classify, rather than to any Han ideograph.
	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
		!CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
		!CN_THROTTLE_PATTERN.test(cleaned)
	);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	// Rolling TPM/RPM windows self-heal, so they never rotate a credential. The
	// reason re-check is the precedence guard: an account-scoped cap that merely
	// quotes a TPM number resolves to QUOTA_EXHAUSTED earlier in that ladder and
	// keeps its usage-limit verdict.
	if (TPM_RPM_THROTTLE_PATTERN.test(errorMessage) && parseRateLimitReason(errorMessage) === "RATE_LIMIT_EXCEEDED") {
		return false;
	}
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		PREPAID_BALANCE_EXHAUSTED_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage) ||
		(CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		matchesSubscriptionCapText(errorMessage)
	);
}

/**
 * Account-scoped cap phrasing delivered on a 403 (or a statusless Connect
 * trailer): "Reached overall message rate limit", "Your limit will reset in …".
 * Kept separate from {@link matchesUsageLimitText} because the bare wording is
 * ambiguous without the 403 / statusless-account context; consumed by both
 * {@link isUsageLimitOutcome} (rotation decision) and `flags.ts` (Flag.UsageLimit).
 */
export function isAccountScopedCapText(message: string): boolean {
	return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

/**
 * A concurrency cap on a non-billing status is shed-and-backoff, not
 * credential-rotatable. This mirrors the exclusion in {@link isUsageLimitOutcome}
 * for the 403 auth-retry entry points. A 402 remains an account-billing cap.
 */
export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
