import { Shell } from "@oh-my-pi/pi-natives";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../sdk";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveReadPath } from "./path-utils";
import { buildInMemorySelectorResult, prependSuffixResolutionNotice, toReadTruncationStats } from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { parseSel } from "./read-selector";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

const JSON_PATH_PATTERN = /\.(?:jsonl?|ndjson)(?=(?::|\?|$))/gi;
const DEFAULT_JSON_QUERY_LIMIT = 100;
const MAX_JSON_QUERY_LIMIT = 1000;
const MAX_QUERY_CAPTURE_BYTES = 5 * 1024 * 1024;
const JSON_QUERY_TIMEOUT_MS = 30_000;
/** jq prints its error last; partial results before it stay out of the error text. */
const JSON_QUERY_ERROR_TAIL_LINES = 20;

export interface JsonPathCandidate {
	jsonPath: string;
	subPath: string;
	queryString: string;
}

export interface JsonSelector {
	kind: "query";
	query: string;
	raw?: boolean;
	compact?: boolean;
	limit?: number;
	offset?: number;
}

function splitJsonRemainder(remainder: string): { subPath: string; queryString: string } {
	const queryIndex = remainder.indexOf("?");
	if (queryIndex === -1) {
		return { subPath: remainder, queryString: "" };
	}
	return {
		subPath: remainder.slice(0, queryIndex),
		queryString: remainder.slice(queryIndex + 1),
	};
}

export function parseJsonPathCandidates(filePath: string): JsonPathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const seen = new Set<string>();
	const candidates: JsonPathCandidate[] = [];

	let match: RegExpExecArray | null;
	JSON_PATH_PATTERN.lastIndex = 0;
	while (true) {
		match = JSON_PATH_PATTERN.exec(normalized);
		if (match === null) break;

		const end = match.index + match[0].length;
		const jsonPath = filePath.slice(0, end);
		const remainder = normalized.slice(end);
		const { subPath, queryString } = splitJsonRemainder(remainder);
		const key = `${jsonPath}\0${subPath}\0${queryString}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ jsonPath, subPath, queryString });
	}

	return candidates.sort((left, right) => right.jsonPath.length - left.jsonPath.length);
}

export function parseJsonSelector(subPath: string, queryString: string): JsonSelector | null {
	const trimmedSubPath = subPath.replace(/^:+/, "").trim();

	// Extract query without form-urlencoded '+' -> ' ' conversion to preserve jq arithmetic '+'
	let query: string | undefined;
	const qMatch = queryString.match(/(?:^|&)(?:q|query)=([^&]*)/);
	if (qMatch) {
		try {
			query = decodeURIComponent(qMatch[1]);
		} catch {
			query = qMatch[1];
		}
	} else if (trimmedSubPath.startsWith("q=")) {
		query = trimmedSubPath.slice(2);
	}

	if (!query) return null;

	const params = new URLSearchParams(queryString);
	const rawParam = params.get("raw")?.toLowerCase();
	const raw = rawParam === "true" || rawParam === "1" || trimmedSubPath.includes("raw");

	const compactParam = params.get("compact")?.toLowerCase();
	const compact = compactParam === "true" || compactParam === "1" || trimmedSubPath.includes("compact");

	let limit: number | undefined;
	const limitParam = params.get("limit");
	if (limitParam !== null) {
		const parsed = Number.parseInt(limitParam, 10);
		if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, MAX_JSON_QUERY_LIMIT);
	}

	let offset: number | undefined;
	const offsetParam = params.get("offset");
	if (offsetParam !== null) {
		const parsed = Number.parseInt(offsetParam, 10);
		if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
	}

	return {
		kind: "query",
		query,
		raw,
		compact,
		limit,
		offset,
	};
}

function stripTrailingNewline(text: string): string {
	if (text.endsWith("\r\n")) {
		return text.slice(0, -2);
	}
	if (text.endsWith("\n")) {
		return text.slice(0, -1);
	}
	return text;
}

function splitJsonValues(text: string): string[] {
	const values: string[] = [];
	let start = 0;
	let inString = false;
	let escape = false;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				const chunk = text.slice(start, i + 1).trim();
				if (chunk) values.push(chunk);
				start = i + 1;
			}
		}
	}
	return values;
}

function formatContinuationHint(
	selector: JsonSelector,
	remaining: number,
	nextOffset: number,
	effectiveLimit: number,
): string {
	const params = new URLSearchParams();
	params.set("q", selector.query);
	if (selector.raw) params.set("raw", "true");
	if (selector.compact) params.set("compact", "true");
	params.set("limit", String(effectiveLimit));
	params.set("offset", String(nextOffset));

	return `\n[${remaining} more items; append ?${params.toString()} to continue]`;
}

function applyPagination(text: string, selector: JsonSelector): string {
	if (selector.offset === undefined && selector.limit === undefined) {
		return text;
	}
	const effectiveOffset = selector.offset ?? 0;
	const effectiveLimit = selector.limit ?? DEFAULT_JSON_QUERY_LIMIT;

	// 1. Single JSON array
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			const sliced = parsed.slice(effectiveOffset, effectiveOffset + effectiveLimit);
			const indent = selector.compact ? undefined : 2;
			let result = JSON.stringify(sliced, null, indent);
			const total = parsed.length;
			const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
			if (remaining > 0) {
				const nextOffset = effectiveOffset + sliced.length;
				result += formatContinuationHint(selector, remaining, nextOffset, effectiveLimit);
			}
			return result;
		}
		// Single JSON object or primitive: do not slice mid-syntax!
		return text;
	} catch {
		// Not a single JSON value, proceed to stream handling
	}

	// 2. Raw line stream
	if (selector.raw) {
		const lines = text.split(/\r?\n/);
		if (lines.length <= 1 && effectiveOffset === 0) {
			return text;
		}
		const sliced = lines.slice(effectiveOffset, effectiveOffset + effectiveLimit);
		let result = sliced.join("\n");
		const total = lines.length;
		const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
		if (remaining > 0) {
			const nextOffset = effectiveOffset + sliced.length;
			result += formatContinuationHint(selector, remaining, nextOffset, effectiveLimit);
		}
		return result;
	}

	// 3. Compact mode stream (1 value per line)
	if (selector.compact) {
		const lines = text.split(/\r?\n/).filter(line => line.length > 0);
		if (lines.length <= 1 && effectiveOffset === 0) {
			return text;
		}
		const sliced = lines.slice(effectiveOffset, effectiveOffset + effectiveLimit);
		let result = sliced.join("\n");
		const total = lines.length;
		const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
		if (remaining > 0) {
			const nextOffset = effectiveOffset + sliced.length;
			result += formatContinuationHint(selector, remaining, nextOffset, effectiveLimit);
		}
		return result;
	}

	// 4. Pretty-printed multi-value stream
	const values = splitJsonValues(text);
	if (values.length > 1) {
		const sliced = values.slice(effectiveOffset, effectiveOffset + effectiveLimit);
		let result = sliced.join("\n");
		const total = values.length;
		const remaining = Math.max(0, total - (effectiveOffset + sliced.length));
		if (remaining > 0) {
			const nextOffset = effectiveOffset + sliced.length;
			result += formatContinuationHint(selector, remaining, nextOffset, effectiveLimit);
		}
		return result;
	}

	return text;
}

export async function executeJsonQuery(
	filePath: string,
	selector: JsonSelector,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) {
		throw new ToolError("Operation aborted");
	}

	const shell = new Shell();
	const flags: string[] = [];
	if (selector.raw) flags.push("-r");
	if (selector.compact) flags.push("-c");

	const quotedQuery = `'${selector.query.replace(/'/g, "'\\''")}'`;
	const quotedPath = `'${filePath.replace(/'/g, "'\\''")}'`;
	// jaq parses any argument starting with `-` as flags even when shell-quoted;
	// `--` keeps filters such as `-.price` positional.
	const command = `jq ${flags.join(" ")} -- ${quotedQuery} ${quotedPath}`;

	let output = "";
	let bytesCaptured = 0;
	let hasError = false;
	const runController = new AbortController();

	const onAbort = () => {
		runController.abort();
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const result = await shell.run(
			{
				command,
				timeoutMs: JSON_QUERY_TIMEOUT_MS,
				signal: runController.signal,
			},
			(err, chunk) => {
				if (err) {
					hasError = true;
				}
				if (chunk) {
					if (bytesCaptured < MAX_QUERY_CAPTURE_BYTES) {
						const remaining = MAX_QUERY_CAPTURE_BYTES - bytesCaptured;
						const toAppend = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
						output += toAppend;
						bytesCaptured += toAppend.length;
					}
					if (bytesCaptured >= MAX_QUERY_CAPTURE_BYTES) {
						runController.abort();
					}
				}
			},
		);

		if (signal?.aborted || (result.cancelled && bytesCaptured === 0)) {
			throw new ToolError("Operation aborted");
		}

		if (result.timedOut) {
			throw new ToolError("JSON query timed out after 30 seconds");
		}

		if (result.exitCode !== 0 || hasError) {
			if (bytesCaptured < MAX_QUERY_CAPTURE_BYTES) {
				const errMsg =
					truncateTail(output.trim(), { maxLines: JSON_QUERY_ERROR_TAIL_LINES }).content ||
					`jq exited with code ${result.exitCode}`;
				throw new ToolError(`Failed to execute JSON query: ${errMsg}`);
			}
		}

		const formatted = stripTrailingNewline(output);
		return applyPagination(formatted, selector);
	} finally {
		if (signal) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

export interface ResolvedJsonReadPath {
	absolutePath: string;
	selector: JsonSelector;
	suffixResolution?: { from: string; to: string };
}

export async function resolveJsonReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedJsonReadPath | null> {
	const candidates = parseJsonPathCandidates(readPath);
	for (const candidate of candidates) {
		const selector = parseJsonSelector(candidate.subPath, candidate.queryString);
		if (!selector) continue;

		const absolutePath = resolveReadPath(candidate.jsonPath, session.cwd);

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (!stat.isFile()) continue;

			return { absolutePath, selector };
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.jsonPath, signal);
			if (!suffixMatch) continue;

			try {
				const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
				if (!retryStat.isFile()) continue;

				return {
					absolutePath: suffixMatch.absolutePath,
					selector,
					suffixResolution: { from: candidate.jsonPath, to: suffixMatch.displayPath },
				};
			} catch {
				// Suffix retry failed, continue to next candidate
			}
		}
	}

	return null;
}

export async function readJson(
	session: ToolSession,
	resolvedJsonPath: ResolvedJsonReadPath,
	lineSelector?: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);

	const details: ReadToolDetails = {
		resolvedPath: resolvedJsonPath.absolutePath,
		suffixResolution: resolvedJsonPath.suffixResolution,
	};

	const queryOutput = await executeJsonQuery(resolvedJsonPath.absolutePath, resolvedJsonPath.selector, signal);

	const output = prependSuffixResolutionNotice(queryOutput, resolvedJsonPath.suffixResolution);

	if (lineSelector) {
		const parsedSel = parseSel(lineSelector);
		if (parsedSel.kind !== "none") {
			return buildInMemorySelectorResult(session, output, parsedSel, {
				details,
				sourcePath: resolvedJsonPath.absolutePath,
				entityLabel: "JSON query output",
				immutable: true,
			});
		}
	}

	const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES });
	details.truncation = truncation.truncated ? toReadTruncationStats(truncation) : undefined;
	const resultBuilder = toolResult<ReadToolDetails>(details)
		.text(truncation.content)
		.sourcePath(resolvedJsonPath.absolutePath);
	if (truncation.truncated) {
		resultBuilder.truncation(truncation, { direction: "head" });
	}

	return resultBuilder.done();
}
