import { getLogsDir, isBunTestRuntime, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as AIError from "../error/flags";
import { appendRetryAfterHint, errorMessageText, getHeadersFromError } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

/**
 * Matches any header name whose value carries a credential, so a persisted dump
 * never leaks one. A substring match — not a hand-maintained allow-list — so
 * provider-specific auth headers (`x-goog-api-key`, `x-amz-security-token`, …)
 * are redacted without enumerating every provider's spelling; the fixed list it
 * replaced silently leaked any auth header it did not name. Redacting a benign
 * header that happens to match is harmless: dumps exist to diagnose the request
 * body, not its transport headers.
 */
const SENSITIVE_HEADER_PATTERN = /key|token|secret|auth|credential|cookie/i;

/**
 * Build the JSON persisted for a rejected request. Request fields stay at the
 * top level (so existing dump parsers still read `body`); the provider's error
 * is added under `errorResponse` so a failed request is diagnosable from the
 * dump file rather than the request alone.
 */
export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

/** HTTP statuses whose rejected request we persist for post-hoc diagnosis: the
 *  request-content rejections that wedge a session. 400 (bad request) and 413
 *  (payload too large — an oversized image / snapcompact frame payload that 413s
 *  and empties the turn). Auth (401/403), not-found (404), rate limits and 5xx
 *  are excluded: 429/5xx are retried, so persisting them here would write one
 *  dump per attempt. */
export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

const RAW_HTTP_REQUEST_LINE = "raw-http-request=";
const RAW_HTTP_REQUEST_SAVE_FAILED_LINE = "raw-http-request-save-failed=";

/**
 * Remove the local request-dump lines {@link appendRawHttpRequestDumpFor400} appends,
 * leaving only the provider-facing error text. Hosts that relay provider errors
 * (RPC `prompt_result`) must not leak OMP-local file paths.
 */
export function stripRawHttpRequestDiagnostics(message: string): string {
	const lines = message.split("\n");
	let end = lines.length;
	while (
		end > 0 &&
		(lines[end - 1].startsWith(RAW_HTTP_REQUEST_LINE) || lines[end - 1].startsWith(RAW_HTTP_REQUEST_SAVE_FAILED_LINE))
	)
		end--;
	return end === lines.length ? message : lines.slice(0, end).join("\n");
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	// Never persist dumps under the test runner: providers exercise the 400 path
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(payload)).toString(36)}.json`;
	const dumpDir = path.join(getLogsDir(), HTTP_DUMP_DIR_NAME);
	const filePath = path.join(dumpDir, fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		// Dumps are rare; bound the directory right after adding to it.
		pruneHttpRequestDumps(dumpDir, { keep: fileName }).catch(err => {
			logger.warn("Failed to prune HTTP request dumps", { dir: dumpDir, err });
		});
		return `${message}\n${RAW_HTTP_REQUEST_LINE}${filePath}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\n${RAW_HTTP_REQUEST_SAVE_FAILED_LINE}${writeMessage}`;
	}
}

const HTTP_DUMP_DIR_NAME = "http-400-requests";
const HTTP_DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HTTP_DUMP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface HttpRequestDumpRetention {
	/** Dump file name never deleted (the one just written and referenced by the error). */
	keep?: string;
	/** Dumps last modified longer ago than this are deleted (default 7 days). */
	maxAgeMs?: number;
	/** Oldest remaining dumps are deleted until the directory totals at most this (default 64 MiB). */
	maxTotalBytes?: number;
	now?: number;
}

/**
 * Bound the rejected-request dump directory: delete `*.json` dumps older than
 * the age limit, then the oldest survivors until the total fits the size cap.
 */
export async function pruneHttpRequestDumps(dir: string, retention: HttpRequestDumpRetention = {}): Promise<void> {
	const maxAgeMs = retention.maxAgeMs ?? HTTP_DUMP_MAX_AGE_MS;
	const maxTotalBytes = retention.maxTotalBytes ?? HTTP_DUMP_MAX_TOTAL_BYTES;
	const now = retention.now ?? Date.now();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	const dumps: Array<{ name: string; mtimeMs: number; size: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const stat = await fs.stat(path.join(dir, name));
			if (stat.isFile()) dumps.push({ name, mtimeMs: stat.mtimeMs, size: stat.size });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	dumps.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	let retainedBytes = 0;
	for (const dump of dumps) {
		if (dump.name === retention.keep) {
			retainedBytes += dump.size;
			continue;
		}
		if (now - dump.mtimeMs <= maxAgeMs && retainedBytes + dump.size <= maxTotalBytes) {
			retainedBytes += dump.size;
			continue;
		}
		await fs.rm(path.join(dir, dump.name), { force: true });
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	const captured = formatCapturedHttpErrorParts(capturedErrorResponse);
	const body = captured
		? mergeCapturedBody(errorMessageText(error), captured, capturedErrorResponse?.status)
		: errorMessageText(error);
	const message = appendRetryAfterHint(body, capturedErrorResponse?.headers ?? getHeadersFromError(error));
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

const STATUS_PREFIX_PATTERN = /^\s*\d{3}\s+/;

/**
 * Fold the captured provider body into the thrown message so it prints once.
 * Works on the message before any retry hint is appended: OpenAI-family errors
 * cap the body they interpolate, so the thrown message may hold only a prefix
 * of the captured body, which the captured copy then replaces.
 */
function mergeCapturedBody(message: string, captured: CapturedHttpErrorText, status: number | undefined): string {
	if (/\bstatus code\s*\(no body\)/i.test(message)) {
		return `${status ?? "HTTP"} status code: ${captured.text}`;
	}
	const statusPrefix = STATUS_PREFIX_PATTERN.exec(message)?.[0] ?? "";
	const body = message.slice(statusPrefix.length).trimEnd();
	const carriesTruncatedBody = body.length > 0 && body.length < captured.core.length && captured.core.startsWith(body);
	if (carriesTruncatedBody) return withSuffix(`${statusPrefix}${captured.core}`, captured);
	if (message.includes(captured.core)) return withSuffix(message, captured);
	return `${message}\n${captured.text}`;
}

function withSuffix(message: string, captured: CapturedHttpErrorText): string {
	return captured.suffix && !message.includes(captured.suffix) ? `${message}${captured.suffix}` : message;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		url: redactUrlQuery(dump.url),
		headers: redactHeaders(dump.headers),
	};
}

/**
 * Strips a persisted dump's query string entirely rather than picking sensitive
 * params by name: a configurable `baseUrl` (e.g. Bedrock's gateway routing) can
 * carry an arbitrary query-based credential the way `SENSITIVE_HEADER_PATTERN`
 * matches arbitrary header names, and dumps exist to diagnose the request body,
 * not the query.
 */
function redactUrlQuery(url: string | undefined): string | undefined {
	if (!url) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.search) return url;
		parsed.search = "";
		return `${parsed.toString()}[redacted-query]`;
	} catch {
		return url;
	}
}

/** Copy of `headers` with every credential value replaced by `[redacted]`; shared by every persisted dump. */
export function redactHeaders<T>(headers: Record<string, T> | undefined): Record<string, T | string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, T | string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADER_PATTERN.test(key)) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

interface CapturedHttpErrorText {
	/** Provider-supplied message with the envelope's structured fields removed. */
	core: string;
	/** `core` followed by the `(type=… param=… code=…)` suffix when the payload carries one. */
	text: string;
	/** Suffix alone, leading space included; absent when the payload has no type/param/code. */
	suffix?: string;
}

function formatCapturedHttpErrorParts(
	captured: CapturedHttpErrorResponse | undefined,
): CapturedHttpErrorText | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return { core: bodyText, text: bodyText };

	const errorPayload = getObjectProperty(payload, "error") ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getStringProperty(payload, "error") : undefined;
	const core =
		getStringProperty(errorPayload, "message") ?? getStringProperty(payload, "message") ?? stringError ?? bodyText;
	const extras = [
		getStringProperty(errorPayload, "type") ?? getStringProperty(payload, "type"),
		getStringProperty(errorPayload, "param") ?? getStringProperty(payload, "param"),
		getStringProperty(errorPayload, "code") ?? getStringProperty(payload, "code"),
	]
		.filter(Boolean)
		.map((value, index) => {
			if (index === 0) return `type=${value}`;
			if (index === 1) return `param=${value}`;
			return `code=${value}`;
		});
	if (extras.length === 0) return { core, text: core };
	const suffix = ` (${extras.join(" ")})`;
	return { core, text: `${core}${suffix}`, suffix };
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isRecord(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		const parsed = JSON.parse(captured.bodyText);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const property = value[key];
	return isRecord(property) ? property : undefined;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const property = value[key];
	return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}
