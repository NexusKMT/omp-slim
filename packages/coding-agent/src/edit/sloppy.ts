import * as nodePath from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../lsp";
import type { ToolSession } from "../tools";
import { routeWriteThroughBridge } from "../tools/acp-bridge";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { type DiffError, type DiffResult, generateDiffString } from "./diff";
import { levenshteinDistance } from "./modes/replace";
import {
	detectIndentChar,
	detectLineEnding,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
	stripBom,
} from "./normalize";
import { readEditFileText, serializeEditFileText } from "./read-file";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "./renderer";
import sloppyGrammarSource from "./sloppy.lark" with { type: "text" };
import description from "./sloppy.md" with { type: "text" };
import { pruneOversizedEditSnapshots } from "./snapshot-details";

/** Context handed to a {@link SloppyVariant} apply call. */
export interface SloppyApplyContext {
	/** Workspace-relative display path of the file being edited — for error messages. */
	readonly path: string;
}

/**
 * The sloppy-format implementation contract: a pure text transformer — no
 * file I/O, no tool state.
 */
export interface SloppyVariant {
	/** Stable format identifier. */
	readonly id: string;
	/** Tool-description markdown teaching the model the payload grammar. */
	readonly description: string;
	/** Apply the payload to full file content and return the new full content. */
	apply(content: string, input: string, context: SloppyApplyContext): string;
}

export const sloppyEditSchema = type({
	input: "string",
});

export type SloppyParams = typeof sloppyEditSchema.infer;

const PATH_HEADER_RE = /^\[([^\]\n]+)\]$/;

/** One `[path]` section of a sloppy payload: a file plus its operations. */
export interface SloppySection {
	path: string;
	body: string;
}

/**
 * Split a sloppy payload into `[path]` sections, hashline-style. The first
 * line MUST be a header; a later whole-line `[path]` opens a new section only
 * when the next non-blank line starts an operation («), so content lines
 * that merely look like headers stay in their operation. Same-path sections
 * merge in order. Returns an empty list when the payload has no leading header.
 */
export function splitSloppySections(input: string): SloppySection[] {
	const lines = input.split("\n");
	if (lines.length === 0 || !PATH_HEADER_RE.test(lines[0])) return [];
	const sections: SloppySection[] = [];
	const bodiesByPath = new Map<string, string[]>();
	let currentPath = "";
	let currentBody: string[] = [];
	const flush = () => {
		if (!currentPath) return;
		let body = bodiesByPath.get(currentPath);
		if (!body) {
			body = [];
			bodiesByPath.set(currentPath, body);
			sections.push({ path: currentPath, body: "" });
		}
		body.push(...currentBody);
		currentBody = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const header = PATH_HEADER_RE.exec(line);
		if (header && (index === 0 || startsOperation(lines, index + 1))) {
			flush();
			currentPath = header[1];
			continue;
		}
		currentBody.push(line);
	}
	flush();
	for (const section of sections) {
		section.body = (bodiesByPath.get(section.path) ?? []).join("\n");
	}
	return sections;
}

/** True when the next non-blank line opens a sloppy operation. */
function startsOperation(lines: string[], from: number): boolean {
	for (let index = from; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (trimmed === "") continue;
		return trimmed.startsWith(OPENER);
	}
	return false;
}

/**
 * Preview one payload section against the file on disk: apply in memory and
 * diff. Used by the streaming edit preview; never writes.
 */
export async function computeSloppySectionDiff(section: SloppySection, cwd: string): Promise<DiffResult | DiffError> {
	try {
		const absolutePath = nodePath.isAbsolute(section.path) ? section.path : nodePath.resolve(cwd, section.path);
		const rawContent = await readEditFileText(absolutePath, section.path);
		const normalizedContent = normalizeToLF(stripBom(rawContent).text);
		const newContent = sloppyVariant.apply(normalizedContent, normalizeToLF(section.body), { path: section.path });
		return generateDiffString(normalizedContent, newContent, undefined, { path: section.path });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export const SLOPPY_MARKERS = {
	open: "«",
	put: "»",
	selectOpen: "⟪",
	selectClose: "⟫",
	gap: "…",
} as const;

const OPENER = SLOPPY_MARKERS.open;
const REWRITE_HEADER = SLOPPY_MARKERS.put;
const SELECT_OPEN = SLOPPY_MARKERS.selectOpen;
const SELECT_CLOSE = SLOPPY_MARKERS.selectClose;
const GAP = SLOPPY_MARKERS.gap;
const MAX_CANDIDATES = 200;
const MAX_COMBINATIONS = 20_000;
const noOpByPath = new Map<string, { hash: string; count: number }>();
const ATOMICITY_NOTICE = "No operations were applied — ops apply atomically; re-send the full corrected payload.";

interface Operation {
	patternText: string;
	rewrite: string;
	all: boolean;
}

interface LiteralToken {
	kind: "literal";
	text: string;
	normalized: string;
}

interface GapToken {
	kind: "gap";
	captureIndex: number;
	lineBounded: boolean;
}

type PatternToken = LiteralToken | GapToken;

interface LiteralFallback {
	normalized: string;
	selectionStart: number;
	selectionEnd: number;
	insertion: boolean;
}

interface ParsedPattern {
	tokens: PatternToken[];
	selectionStart: number;
	selectionEnd: number;
	insertion: boolean;
	lineInsertion: boolean;
	selectedCaptureIndices: number[];
	selectionRanges: Array<{ start: number; end: number }>;
	literalFallback: LiteralFallback | undefined;
}

interface NormalizedText {
	text: string;
	starts: number[];
	ends: number[];
}

interface Occurrence {
	start: number;
	end: number;
	distance: number;
	punctuationEdits: number;
}

interface Candidate {
	start: number;
	end: number;
	matchStart: number;
	matchEnd: number;
	captures: string[];
	selectionSpans: Array<{ start: number; end: number }>;
	tuple: number[];
}

interface CandidateResult {
	candidates: Candidate[];
	overflow: boolean;
}

interface PlannedEdit {
	start: number;
	end: number;
	replacement: string;
	operationNumber: number;
}

function parseOpener(line: string): number | undefined | false {
	const match = line.trim().match(/^«(\*?)$/u);
	if (!match) return false;
	return match[1] ? 0 : undefined;
}

/** A numbered opener: the author meant either a unique match or every match. */
function isOrdinalOpener(line: string): boolean {
	return /^«[1-9]\d*$/u.test(line.trim());
}

function normalizeInput(input: string): string {
	const lines = input
		.split("\n")
		.filter(line => {
			const trimmed = line.trim();
			return !/^\*{3}\s*(?:Begin Patch|End Patch|Abort|Update File:|Add File:|Delete File:)/iu.test(trimmed);
		})
		.flatMap(line => {
			const glued = line.match(/^(«\*?|»)([ \t]+\S.*)$/u);
			return glued ? [glued[1], glued[2]] : [line];
		});
	while (lines[0]?.trim() === "") lines.shift();
	if (/^```(?:text|typescript|ts|tsx|javascript|js)?\s*$/iu.test(lines[0]?.trim() ?? "")) {
		lines.shift();
		while (lines.at(-1)?.trim() === "") lines.pop();
		if (lines.at(-1)?.trim() === "```") lines.pop();
	}
	while (lines[0]?.trim() === "") lines.shift();
	while (lines.at(-1)?.trim() === "") lines.pop();
	return lines.join("\n");
}

function normalizeBlock(lines: string[], rewrite: boolean): string {
	const cleaned = lines.filter(line => {
		const trimmed = line.trim();
		return !(
			/^\[(?:Showing lines\b|(?:…|\.\.\.)\d+ln elided\b).*\]$/iu.test(trimmed) ||
			/^\d+(?:-\d+)?:\s*(?:…|\.\.\.)\s*$/u.test(trimmed)
		);
	});
	while (cleaned.at(-1)?.trim() === "") cleaned.pop();
	const nonBlank = cleaned.filter(line => line.trim() !== "");
	if (
		nonBlank.length > 0 &&
		nonBlank.every(line => /^\s*\d+\s*[:|]/u.test(line)) &&
		!nonBlank.every(line => /^\s*\d+\s*[:|]\s*(?:\d|["'`])/u.test(line))
	) {
		for (let index = 0; index < cleaned.length; index++) {
			cleaned[index] = cleaned[index].replace(/^\s*\d+\s*[:|]/u, "");
		}
	}
	if (rewrite) {
		const hasOld = cleaned.some(line => /^-(?!---)/u.test(line));
		const hasNew = cleaned.some(line => /^\+(?!\+\+)/u.test(line));
		if (hasOld && hasNew) {
			return cleaned
				.filter(line => !/^-(?!---)/u.test(line) && !/^(?:---|\+\+\+)(?:\s|$)/u.test(line))
				.map(line => (line.startsWith("+") ? line.slice(1) : line))
				.join("\n");
		}
		if (nonBlank.length > 0 && nonBlank.every(line => line.startsWith("+"))) {
			return cleaned.map(line => (line.startsWith("+") ? line.slice(1) : line)).join("\n");
		}
	}
	return cleaned.join("\n");
}

function recoverMissingSeparator(
	lines: string[],
	content: string,
): { patternText: string; rewrite: string } | undefined {
	const candidates: Array<{ patternText: string; rewrite: string }> = [];
	for (let split = 1; split < lines.length; split++) {
		let remainderStart = split;
		while (lines[remainderStart]?.trim() === "") remainderStart++;
		if (remainderStart >= lines.length) continue;
		const patternText = normalizeBlock(lines.slice(0, split), false);
		const rewrite = normalizeBlock(lines.slice(remainderStart), true);
		if (patternText.length < 4 || rewrite.trim() === "") continue;
		const matches = exactOccurrences(content, patternText);
		if (matches.length !== 1) continue;
		const throughFirstRewriteLine = normalizeBlock(lines.slice(0, remainderStart + 1), false);
		if (content.startsWith(throughFirstRewriteLine, matches[0].start)) continue;
		if (!candidates.some(candidate => candidate.patternText === patternText && candidate.rewrite === rewrite)) {
			candidates.push({ patternText, rewrite });
		}
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function recoverAlternatingSeparators(lines: string[], content: string): string[] | undefined {
	if (lines.some(line => line.trim() === REWRITE_HEADER)) return undefined;
	const headers = lines.flatMap((line, index) => (parseOpener(line) === false ? [] : [index]));
	if (headers.length < 2 || headers.length % 2 !== 0 || headers[0] !== 0) return undefined;
	const normalizedContent = normalizeText(content).text;
	const recovered: string[] = [];
	for (let pair = 0; pair < headers.length; pair += 2) {
		const matchStart = headers[pair];
		const rewriteStart = headers[pair + 1];
		const next = headers[pair + 2] ?? lines.length;
		const matchLines = lines.slice(matchStart + 1, rewriteStart);
		const rewriteLines = lines.slice(rewriteStart + 1, next);
		const normalizedMatch = normalizeText(normalizeBlock(matchLines, false)).text;
		const normalizedRewrite = normalizeText(normalizeBlock(rewriteLines, true)).text;
		if (
			normalizedMatch === "" ||
			normalizedRewrite === "" ||
			!normalizedContent.includes(normalizedMatch) ||
			normalizedContent.includes(normalizedRewrite)
		) {
			return undefined;
		}
		recovered.push(lines[matchStart], ...matchLines, REWRITE_HEADER, ...rewriteLines);
	}
	return recovered;
}

function parseOperations(input: string, content: string): Operation[] {
	const payload = normalizeInput(input);
	let lines = payload.split("\n");
	if (
		parseOpener(lines[0] ?? "") === false &&
		(lines.some(line => line.trim() === REWRITE_HEADER) ||
			payload.includes(SELECT_OPEN) ||
			payload.includes(SELECT_CLOSE))
	) {
		lines.unshift(OPENER);
	}
	lines = recoverAlternatingSeparators(lines, content) ?? lines;
	const operations: Operation[] = [];
	let state: "outside" | "pattern" | "rewrite" = "outside";
	let allMatches = false;
	let patternLines: string[] = [];
	let rewriteLines: string[] = [];

	const finish = () => {
		operations.push({
			patternText: normalizeBlock(patternLines, false),
			rewrite: normalizeBlock(rewriteLines, true),
			all: allMatches,
		});
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const parsedOpener = parseOpener(line);
		const trimmed = line.trim();
		const registerReference = trimmed.match(/^»([1-9]\d*)$/u);
		if (isOrdinalOpener(line)) {
			throw new Error(
				`${trimmed} is not a valid opener. Use ${OPENER} with a pattern that matches once — add context only the intended match has — or ${OPENER}* to change every match.`,
			);
		}
		if (
			parsedOpener === false &&
			(trimmed.startsWith(OPENER) ||
				(trimmed.startsWith(REWRITE_HEADER) && trimmed !== REWRITE_HEADER && !registerReference))
		) {
			throw new Error(
				`Invalid control line ${JSON.stringify(trimmed)}; use only ${OPENER}, ${OPENER}*, ${REWRITE_HEADER}, or ${REWRITE_HEADER}N in REWRITE.`,
			);
		}
		if (state === "outside") {
			if (parsedOpener !== false) {
				allMatches = parsedOpener === 0;
				patternLines = [];
				rewriteLines = [];
				state = "pattern";
			} else if (line.trim() !== "") {
				throw new Error(`Expected ${OPENER} on input line ${index + 1}.`);
			}
			continue;
		}

		if (state === "pattern") {
			if (line.trim() === REWRITE_HEADER) {
				state = "rewrite";
			} else if (registerReference) {
				throw new Error(`${REWRITE_HEADER}${registerReference[1]} is valid only in REWRITE, never MATCH.`);
			} else if (parsedOpener !== false) {
				const recovered = recoverMissingSeparator(patternLines, content);
				if (!recovered) {
					throw new Error(
						`Operation ${operations.length + 1} needs ${REWRITE_HEADER}. Retry:\n${OPENER}\n${patternLines.join("\n")}\n${REWRITE_HEADER}\n<new text>`,
					);
				}
				operations.push({ ...recovered, all: allMatches });
				allMatches = parsedOpener === 0;
				patternLines = [];
				rewriteLines = [];
			} else {
				patternLines.push(line);
			}
			continue;
		}

		if (parsedOpener !== false) {
			finish();
			allMatches = parsedOpener === 0;
			patternLines = [];
			rewriteLines = [];
			state = "pattern";
		} else if (line.trim() === REWRITE_HEADER) {
			throw new Error(`Operation ${operations.length + 1} has a second ${REWRITE_HEADER} line.`);
		} else {
			rewriteLines.push(line);
		}
	}

	if (state === "rewrite") finish();
	else if (state === "pattern") {
		const recovered = recoverMissingSeparator(patternLines, content);
		if (recovered) {
			operations.push({ ...recovered, all: allMatches });
		} else {
			throw new Error(
				`Operation ${operations.length + 1} needs ${REWRITE_HEADER}. Retry:\n${OPENER}\n${patternLines.join("\n")}\n${REWRITE_HEADER}\n<new text>`,
			);
		}
	}
	if (operations.length === 0) throw new Error(`Empty patch. Start with ${OPENER}.`);
	for (let index = 0; index < operations.length; index++) {
		for (const line of operations[index].rewrite.split("\n")) {
			const reference = line.trim().match(/^»([1-9]\d*)$/u);
			if (reference && Number(reference[1]) >= index + 1) {
				throw new Error(`${REWRITE_HEADER}${reference[1]} must reference an earlier operation, not self/forward.`);
			}
		}
	}
	return operations;
}

function normalizeText(source: string): NormalizedText {
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	for (let index = 0; index < source.length; ) {
		const codePoint = source.codePointAt(index);
		if (codePoint === undefined) break;
		const raw = String.fromCodePoint(codePoint);
		const next = index + raw.length;
		for (const character of normalizeUnicode(raw)) {
			if (/\s/u.test(character)) continue;
			text += character;
			// One entry per UTF-16 code unit: occurrence offsets index `text` by
			// code unit, so astral characters must occupy two mapping slots.
			for (let unit = 0; unit < character.length; unit++) {
				starts.push(index);
				ends.push(next);
			}
		}
		index = next;
	}
	return { text, starts, ends };
}

function asciiEllipsisIsQuotedOnLine(source: string, offset: number): boolean {
	const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	for (let index = lineStart; index < offset; index++) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote !== undefined && character === "\\") {
			escaped = true;
			continue;
		}
		if (quote === undefined) {
			if (character === "'" || character === '"' || character === "`") quote = character;
		} else if (character === quote) {
			quote = undefined;
		}
	}
	return quote !== undefined;
}

function patternGapAt(source: string, offset: number): string | undefined {
	return source.startsWith(GAP, offset) ? GAP : undefined;
}

function patternContainsGap(source: string): boolean {
	for (let index = 0; index < source.length; ) {
		const marker = patternGapAt(source, index);
		if (marker) return true;
		const codePoint = source.codePointAt(index);
		if (codePoint === undefined) break;
		index += String.fromCodePoint(codePoint).length;
	}
	return false;
}

function parsePattern(pattern: string, operationNumber: number): ParsedPattern {
	if (pattern.trim() === "") throw new Error(`Operation ${operationNumber} has an empty pattern.`);
	const openCount = (pattern.match(/⟪/gu) || []).length;
	const closeCount = (pattern.match(/⟫/gu) || []).length;
	if (openCount !== closeCount) {
		throw new Error(
			openCount > closeCount
				? `Operation ${operationNumber} has an unclosed selection marker ⟪; add closing ⟫.`
				: `Operation ${operationNumber} has an unmatched closing selection marker ⟫; add opening ⟪.`,
		);
	}
	const hasGap = patternContainsGap(pattern);
	const hasSelection = openCount > 0;
	if (!hasGap && !hasSelection) {
		const normalized = normalizeText(pattern).text;
		if (normalized === "") throw new Error(`Operation ${operationNumber} has no visible current text.`);
		return {
			tokens: [{ kind: "literal", text: pattern, normalized }],
			selectionStart: 0,
			selectionEnd: 1,
			insertion: false,
			lineInsertion: false,
			selectedCaptureIndices: [],
			selectionRanges: [],
			literalFallback: undefined,
		};
	}

	const tokens: PatternToken[] = [];
	let literal = "";
	let captureCount = 0;
	const selectionBoundaries: number[] = [];
	const selectionAtLineStart: boolean[] = [];
	const selectionRawOffsets: number[] = [];
	const flushLiteral = () => {
		if (literal === "") return;
		const normalized = normalizeText(literal).text;
		if (normalized !== "") tokens.push({ kind: "literal", text: literal, normalized });
		literal = "";
	};

	for (let index = 0; index < pattern.length; ) {
		const gapMarker = patternGapAt(pattern, index);
		if (gapMarker) {
			flushLiteral();
			if (tokens.at(-1)?.kind === "gap") {
				throw new Error(`Operation ${operationNumber} has adjacent ${GAP}; use one ellipsis.`);
			}
			const lineStart = pattern.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
			const nextNewline = pattern.indexOf("\n", index + gapMarker.length);
			const lineEnd = nextNewline === -1 ? pattern.length : nextNewline;
			const before = pattern.slice(lineStart, index).replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "").trim();
			const after = pattern
				.slice(index + gapMarker.length, lineEnd)
				.replaceAll(SELECT_OPEN, "")
				.replaceAll(SELECT_CLOSE, "")
				.trim();
			tokens.push({
				kind: "gap",
				captureIndex: captureCount++,
				lineBounded: before !== "" && after !== "",
			});
			index += gapMarker.length;
			continue;
		}
		const codePoint = pattern.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character === SELECT_OPEN) {
			flushLiteral();
			selectionBoundaries.push(tokens.length);
			selectionRawOffsets.push(index);
			const lineStart = pattern.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
			selectionAtLineStart.push(pattern.slice(lineStart, index).trim() === "");
		} else if (character === SELECT_CLOSE) {
			flushLiteral();
			selectionBoundaries.push(tokens.length);
			selectionRawOffsets.push(index);
		} else {
			literal += character;
		}
		index += character.length;
	}
	flushLiteral();

	let strippedLeading = 0;
	while (tokens[0]?.kind === "gap") {
		tokens.shift();
		strippedLeading++;
	}
	while (tokens.at(-1)?.kind === "gap") tokens.pop();
	for (let index = 0; index < selectionBoundaries.length; index++) {
		selectionBoundaries[index] = Math.max(0, Math.min(tokens.length, selectionBoundaries[index] - strippedLeading));
	}
	const literals = tokens.filter((token): token is LiteralToken => token.kind === "literal");
	if (literals.length === 0) throw new Error(`Operation ${operationNumber} needs visible current text.`);
	// Only punctuation-only anchors (`}`, `};`, `);`) are genuinely too generic:
	// they match everywhere and their candidate lists are noise. Any identifier
	// text — however short (`id`, `avlue`) — is a legitimate anchor; uniqueness
	// (or an explicit `«*`) decides whether it applies, not its length.
	const hasIdentifierText = literals.some(token => /[\p{L}\p{N}_$]/u.test(token.normalized));
	if (!hasIdentifierText) {
		throw new Error(`Operation ${operationNumber} pattern is too generic; include a distinctive name or statement.`);
	}

	const emptyDoubleSelection = selectionBoundaries.length === 2 && selectionBoundaries[0] === selectionBoundaries[1];
	const insertion = selectionBoundaries.length === 1 || emptyDoubleSelection;
	const explicitSingleSelection = selectionBoundaries.length === 2 && !emptyDoubleSelection;
	const selectionStart = insertion || explicitSingleSelection ? selectionBoundaries[0] : 0;
	const selectionEnd = insertion ? selectionStart : explicitSingleSelection ? selectionBoundaries[1] : tokens.length;
	const selectionRanges =
		selectionBoundaries.length > 2 && selectionBoundaries.length % 2 === 0
			? Array.from({ length: selectionBoundaries.length / 2 }, (_, index) => ({
					start: selectionBoundaries[index * 2],
					end: selectionBoundaries[index * 2 + 1],
				}))
			: [];
	const selectedCaptureIndices = tokens
		.slice(selectionStart, selectionEnd)
		.filter((token): token is GapToken => token.kind === "gap")
		.map(token => token.captureIndex);
	const literalFallbackText =
		selectionRanges.length === 0 && pattern.includes(GAP)
			? pattern.replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "")
			: undefined;
	let literalFallback: LiteralFallback | undefined;
	if (literalFallbackText !== undefined) {
		const normalized = normalizeText(literalFallbackText).text;
		const normalizedOffset = (rawOffset: number) =>
			normalizeText(pattern.slice(0, rawOffset).replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "")).text
				.length;
		literalFallback = {
			normalized,
			selectionStart: insertion || explicitSingleSelection ? normalizedOffset(selectionRawOffsets[0]) : 0,
			selectionEnd: insertion
				? normalizedOffset(selectionRawOffsets[0])
				: explicitSingleSelection
					? normalizedOffset(selectionRawOffsets[1])
					: normalized.length,
			insertion,
		};
	}
	return {
		tokens,
		selectionStart,
		selectionEnd,
		insertion,
		lineInsertion: insertion && selectionAtLineStart[0],
		selectedCaptureIndices,
		selectionRanges,
		literalFallback,
	};
}

function exactOccurrences(content: string, pattern: string): Occurrence[] {
	const occurrences: Occurrence[] = [];
	let from = 0;
	while (from <= content.length - pattern.length) {
		const start = content.indexOf(pattern, from);
		if (start === -1) break;
		occurrences.push({ start, end: start + pattern.length, distance: 0, punctuationEdits: 0 });
		from = start + 1;
	}
	return occurrences;
}

function operatorSignature(text: string): string {
	return [...text].filter(character => !/[\p{L}\p{N}_$]/u.test(character)).join("");
}

function differsByOnePunctuationInsertion(left: string, right: string): boolean {
	const leftCharacters = [...left];
	const rightCharacters = [...right];
	if (Math.abs(leftCharacters.length - rightCharacters.length) !== 1) return false;
	const shorter = leftCharacters.length < rightCharacters.length ? leftCharacters : rightCharacters;
	const longer = leftCharacters.length < rightCharacters.length ? rightCharacters : leftCharacters;
	let shortIndex = 0;
	let inserted: string | undefined;
	for (let longIndex = 0; longIndex < longer.length; longIndex++) {
		if (shorter[shortIndex] === longer[longIndex]) {
			shortIndex++;
			continue;
		}
		if (inserted !== undefined) return false;
		inserted = longer[longIndex];
	}
	inserted ??= longer.at(-1);
	return inserted !== undefined && !/[{}()[\]]/u.test(inserted);
}

function punctuationCompatible(pattern: string, candidate: string, allowSingleInsertion: boolean): boolean {
	const expected = operatorSignature(pattern);
	const actual = operatorSignature(candidate);
	return expected === actual || (allowSingleInsertion && differsByOnePunctuationInsertion(expected, actual));
}

function fuzzyOccurrences(content: string, pattern: string, allowSinglePunctuationInsertion = false): Occurrence[] {
	if (content.length === 0 || content.length > 50_000) return [];
	if (pattern.length < 6) return exactOccurrences(content, pattern);
	const limit = Math.min(3, Math.max(1, Math.floor(pattern.length * 0.12)));
	const seedLength = Math.min(5, Math.max(3, pattern.length - limit));
	const offsets = [0, Math.floor((pattern.length - seedLength) / 2), pattern.length - seedLength];
	const structural = operatorSignature(pattern);
	const candidateStarts = new Set<number>();
	for (const offset of offsets) {
		const seed = pattern.slice(offset, offset + seedLength);
		let from = 0;
		while (from <= content.length - seed.length) {
			const found = content.indexOf(seed, from);
			if (found === -1) break;
			for (let delta = -limit; delta <= limit; delta++) {
				const start = found - offset + delta;
				if (start >= 0 && start < content.length) candidateStarts.add(start);
			}
			from = found + 1;
		}
	}
	if (candidateStarts.size === 0 && content.length <= 10_000) {
		for (let start = 0; start < content.length; start++) candidateStarts.add(start);
	}

	const raw: Occurrence[] = [];
	for (const start of candidateStarts) {
		let best: Occurrence | undefined;
		for (let length = Math.max(1, pattern.length - limit); length <= pattern.length + limit; length++) {
			if (start + length > content.length) continue;
			const candidateText = content.slice(start, start + length);
			if (
				operatorSignature(candidateText) !== structural &&
				(!allowSinglePunctuationInsertion || !punctuationCompatible(pattern, candidateText, true))
			) {
				continue;
			}
			const distance = levenshteinDistance(pattern, candidateText);
			if (distance > limit || (best && distance >= best.distance)) continue;
			best = {
				start,
				end: start + length,
				distance,
				punctuationEdits: operatorSignature(candidateText) === structural ? 0 : 1,
			};
		}
		if (best) raw.push(best);
	}
	raw.sort((left, right) => left.distance - right.distance || left.start - right.start);
	const distinct: Occurrence[] = [];
	for (const candidate of raw) {
		if (distinct.some(kept => candidate.start < kept.end && candidate.end > kept.start)) continue;
		distinct.push(candidate);
	}
	return distinct.sort((left, right) => left.start - right.start);
}

function sourceStart(normalized: NormalizedText, offset: number, fallback: number): number {
	return normalized.starts[offset] ?? fallback;
}

function sourceEnd(normalized: NormalizedText, offset: number, fallback: number): number {
	if (offset <= 0) return 0;
	return normalized.ends[offset - 1] ?? fallback;
}

function precedingLiteral(tokens: PatternToken[], boundary: number): number | undefined {
	for (let index = boundary - 1; index >= 0; index--) if (tokens[index].kind === "literal") return index;
	return undefined;
}

function followingLiteral(tokens: PatternToken[], boundary: number): number | undefined {
	for (let index = boundary; index < tokens.length; index++) if (tokens[index].kind === "literal") return index;
	return undefined;
}

function resolveBoundary(
	boundary: number,
	kind: "start" | "end" | "empty",
	tokens: PatternToken[],
	matches: ReadonlyMap<number, Occurrence>,
	normalized: NormalizedText,
): number {
	const previousIndex = precedingLiteral(tokens, boundary);
	const nextIndex = followingLiteral(tokens, boundary);
	const previous = previousIndex === undefined ? undefined : matches.get(previousIndex);
	const next = nextIndex === undefined ? undefined : matches.get(nextIndex);
	const immediatePrevious = boundary > 0 && tokens[boundary - 1]?.kind === "literal";
	const immediateNext = boundary < tokens.length && tokens[boundary]?.kind === "literal";
	if (kind === "empty") {
		if (next) return sourceStart(normalized, next.start, normalized.text.length);
		if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	}
	if (kind === "start") {
		if (immediateNext && next) return sourceStart(normalized, next.start, normalized.text.length);
		if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
		if (next) return sourceStart(normalized, next.start, normalized.text.length);
	}
	if (immediatePrevious && previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	if (next) return sourceStart(normalized, next.start, normalized.text.length);
	if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	return 0;
}

function collectCandidates(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	fuzzy: boolean,
	allowSinglePunctuationInsertion = false,
): CandidateResult {
	const literalIndices = pattern.tokens.flatMap((token, index) => (token.kind === "literal" ? [index] : []));
	const occurrences = new Map<number, Occurrence[]>();
	for (const index of literalIndices) {
		const token = pattern.tokens[index] as LiteralToken;
		occurrences.set(
			index,
			fuzzy
				? fuzzyOccurrences(normalized.text, token.normalized, allowSinglePunctuationInsertion)
				: exactOccurrences(normalized.text, token.normalized),
		);
	}
	if (literalIndices.some(index => occurrences.get(index)?.length === 0)) return { candidates: [], overflow: false };

	const candidates: Candidate[] = [];
	const chosen = new Map<number, Occurrence>();
	let combinations = 0;
	let overflow = false;
	const visit = (position: number) => {
		if (overflow) return;
		if (candidates.length >= MAX_CANDIDATES || combinations >= MAX_COMBINATIONS) {
			overflow = true;
			return;
		}
		if (position === literalIndices.length) {
			if (
				allowSinglePunctuationInsertion &&
				literalIndices.reduce((total, index) => total + (chosen.get(index)?.punctuationEdits ?? 0), 0) > 1
			) {
				return;
			}
			combinations++;
			const start = resolveBoundary(
				pattern.selectionStart,
				pattern.insertion ? "empty" : "start",
				pattern.tokens,
				chosen,
				normalized,
			);
			const end = resolveBoundary(
				pattern.selectionEnd,
				pattern.insertion ? "empty" : "end",
				pattern.tokens,
				chosen,
				normalized,
			);
			const first = chosen.get(literalIndices[0]);
			const last = chosen.get(literalIndices.at(-1) ?? -1);
			if (start > end || !first || !last) return;
			const captures = new Array<string>(pattern.tokens.filter(token => token.kind === "gap").length).fill("");
			for (let tokenIndex = 0; tokenIndex < pattern.tokens.length; tokenIndex++) {
				const token = pattern.tokens[tokenIndex];
				if (token.kind !== "gap") continue;
				const beforeIndex = precedingLiteral(pattern.tokens, tokenIndex);
				const afterIndex = followingLiteral(pattern.tokens, tokenIndex + 1);
				const before = beforeIndex === undefined ? undefined : chosen.get(beforeIndex);
				const after = afterIndex === undefined ? undefined : chosen.get(afterIndex);
				if (!before || !after) return;
				const captureStart = sourceEnd(normalized, before.end, content.length);
				const captureEnd = sourceStart(normalized, after.start, content.length);
				captures[token.captureIndex] = content.slice(captureStart, captureEnd);
			}
			const selectionSpans = pattern.selectionRanges.map(range => {
				const empty = range.start === range.end;
				return {
					start: resolveBoundary(range.start, empty ? "empty" : "start", pattern.tokens, chosen, normalized),
					end: resolveBoundary(range.end, empty ? "empty" : "end", pattern.tokens, chosen, normalized),
				};
			});
			if (selectionSpans.some(span => span.start > span.end)) return;
			const candidate: Candidate = {
				start,
				end,
				matchStart: sourceStart(normalized, first.start, 0),
				matchEnd: sourceEnd(normalized, last.end, content.length),
				captures,
				tuple: literalIndices.map(index => chosen.get(index)?.start ?? -1),
				selectionSpans,
			};
			const duplicateIndex = candidates.findIndex(
				existing =>
					existing.start === start &&
					existing.end === end &&
					pattern.selectedCaptureIndices.every(
						captureIndex => existing.captures[captureIndex] === captures[captureIndex],
					),
			);
			if (duplicateIndex === -1) {
				candidates.push(candidate);
			} else {
				const existing = candidates[duplicateIndex];
				if (candidate.matchEnd - candidate.matchStart < existing.matchEnd - existing.matchStart) {
					candidates[duplicateIndex] = candidate;
				}
			}
			return;
		}

		const tokenIndex = literalIndices[position];
		const previousIndex = position === 0 ? undefined : literalIndices[position - 1];
		const previous = previousIndex === undefined ? undefined : chosen.get(previousIndex);
		const gapTokens =
			previousIndex === undefined
				? []
				: pattern.tokens
						.slice(previousIndex + 1, tokenIndex)
						.filter((token): token is GapToken => token.kind === "gap");
		const hasGap = gapTokens.length > 0;
		for (const occurrence of occurrences.get(tokenIndex) ?? []) {
			if (previous && (hasGap ? occurrence.start < previous.end : occurrence.start !== previous.end)) continue;
			if (previous && gapTokens.some(token => token.lineBounded)) {
				const gapStart = sourceEnd(normalized, previous.end, content.length);
				const gapEnd = sourceStart(normalized, occurrence.start, content.length);
				if (content.slice(gapStart, gapEnd).includes("\n")) continue;
			}
			chosen.set(tokenIndex, occurrence);
			visit(position + 1);
			chosen.delete(tokenIndex);
		}
	};
	visit(0);
	const minimalCandidates = candidates.filter(
		candidate =>
			!candidates.some(other => other.matchStart === candidate.matchStart && other.matchEnd < candidate.matchEnd),
	);
	minimalCandidates.sort(
		(left, right) =>
			left.start - right.start ||
			left.matchStart - right.matchStart ||
			left.matchEnd - right.matchEnd ||
			left.tuple.join(",").localeCompare(right.tuple.join(",")),
	);
	return { candidates: minimalCandidates, overflow };
}

function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index++) if (content[index] === "\n") line++;
	return line;
}

function operationPayload(operation: Operation, target: "*" | "" = ""): string {
	return `${OPENER}${target}\n${operation.patternText}\n${REWRITE_HEADER}\n${operation.rewrite}`;
}

function exactAndFuzzyCandidates(content: string, pattern: ParsedPattern): CandidateResult {
	const normalized = normalizeText(content);
	const exact = collectCandidates(content, normalized, pattern, false);
	const fuzzy = collectCandidates(content, normalized, pattern, true);
	const candidates = [...exact.candidates];
	for (const candidate of fuzzy.candidates) {
		if (
			candidates.some(
				existing =>
					existing.start === candidate.start &&
					existing.end === candidate.end &&
					existing.matchStart === candidate.matchStart &&
					existing.matchEnd === candidate.matchEnd,
			)
		) {
			continue;
		}
		candidates.push(candidate);
	}
	candidates.sort(
		(left, right) =>
			left.start - right.start ||
			left.end - right.end ||
			left.matchStart - right.matchStart ||
			left.matchEnd - right.matchEnd,
	);
	return { candidates, overflow: exact.overflow || fuzzy.overflow };
}

function displayFragment(text: string): string {
	if (text.includes("\n") && text.split("\n").length <= 8) return `\n${text}`;
	const compact = text.trim().replace(/\s+/gu, " ");
	return JSON.stringify(compact.length > 80 ? `${compact.slice(0, 77)}…` : compact);
}

function occurrencesForLiteral(normalized: NormalizedText, token: LiteralToken): Occurrence[] {
	const exact = exactOccurrences(normalized.text, token.normalized);
	return exact.length > 0 ? exact : fuzzyOccurrences(normalized.text, token.normalized);
}

function pairCanAlign(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	leftIndex: number,
	rightIndex: number,
	leftOccurrences: Occurrence[],
	rightOccurrences: Occurrence[],
): boolean {
	const gaps = pattern.tokens
		.slice(leftIndex + 1, rightIndex)
		.filter((token): token is GapToken => token.kind === "gap");
	return leftOccurrences.some(left =>
		rightOccurrences.some(right => {
			if (gaps.length === 0 && right.start !== left.end) return false;
			if (gaps.length > 0 && right.start < left.end) return false;
			if (gaps.some(gap => gap.lineBounded)) {
				const gapStart = sourceEnd(normalized, left.end, content.length);
				const gapEnd = sourceStart(normalized, right.start, content.length);
				if (content.slice(gapStart, gapEnd).includes("\n")) return false;
			}
			return true;
		}),
	);
}
function closestFragment(
	content: string,
	token: LiteralToken,
	centerOffset?: number,
): { text: string; offset: number } {
	const ranked: Array<{ line: string; offset: number; normalized: NormalizedText; score: number }> = [];
	const centerLine = centerOffset === undefined ? undefined : lineNumberAt(content, centerOffset) - 1;
	let offset = 0;
	let lineIndex = 0;
	for (const line of content.split("\n")) {
		const normalized = normalizeText(line);
		if (normalized.text !== "" && (centerLine === undefined || Math.abs(lineIndex - centerLine) <= 12)) {
			const score =
				levenshteinDistance(token.normalized, normalized.text) /
				Math.max(1, token.normalized.length, normalized.text.length);
			ranked.push({ line, offset, normalized, score });
			ranked.sort((left, right) => left.score - right.score);
			if (ranked.length > 3) ranked.pop();
		}
		lineIndex++;
		offset += line.length + 1;
	}
	const first = ranked[0];
	if (!first && centerOffset !== undefined) return closestFragment(content, token);
	if (!first) return { text: token.text, offset: 0 };

	let best = { text: first.line, offset: first.offset, score: first.score };
	if (token.normalized.length <= 160) {
		for (const candidateLine of ranked) {
			const lineText = candidateLine.normalized.text;
			const width = Math.min(token.normalized.length, lineText.length);
			for (let start = 0; start <= lineText.length - width; start++) {
				const end = start + width;
				const candidate = lineText.slice(start, end);
				const score =
					levenshteinDistance(token.normalized, candidate) /
					Math.max(1, token.normalized.length, candidate.length);
				if (score >= best.score) continue;
				const rawStart = sourceStart(candidateLine.normalized, start, 0);
				const rawEnd = sourceEnd(candidateLine.normalized, end, candidateLine.line.length);
				best = {
					text: candidateLine.line.slice(rawStart, rawEnd),
					offset: candidateLine.offset + rawStart,
					score,
				};
			}
		}
	}
	return { text: best.text, offset: best.offset };
}

function numberedPreview(content: string, offset: number): string {
	const lines = content.split("\n");
	const anchor = Math.max(0, lineNumberAt(content, Math.min(offset, content.length)) - 1);
	let start = Math.max(0, anchor - 4);
	if (lines.length - start < 10) start = Math.max(0, lines.length - 10);
	return lines
		.slice(start, start + 10)
		.map((line, index) => `${start + index + 1}: ${line}`)
		.join("\n");
}

function noMatchGuidance(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	operation: Operation,
): { reason: string; previewOffset: number; correctedPattern: string; additionRetry?: string } {
	const literals = pattern.tokens.flatMap((token, index) =>
		token.kind === "literal" ? [{ index, token, occurrences: occurrencesForLiteral(normalized, token) }] : [],
	);
	const missing = literals.find(literal => literal.occurrences.length === 0);
	if (missing) {
		const anchor = literals
			.filter(literal => literal.occurrences.length > 0)
			.sort(
				(left, right) =>
					right.token.normalized.length - left.token.normalized.length ||
					left.occurrences.length - right.occurrences.length,
			)[0];
		const anchorOffset = anchor?.occurrences[0] ? sourceStart(normalized, anchor.occurrences[0].start, 0) : undefined;
		const closest = closestFragment(content, missing.token, anchorOffset);
		const at = operation.patternText.indexOf(missing.token.text);
		const correctedPattern =
			at >= 0 && closest.text !== ""
				? operation.patternText.slice(0, at) +
					closest.text +
					operation.patternText.slice(at + missing.token.text.length)
				: operation.patternText;
		const lineStart = content.lastIndexOf("\n", Math.max(0, closest.offset - 1)) + 1;
		const newline = content.indexOf("\n", closest.offset);
		const neighborLine = content.slice(lineStart, newline === -1 ? content.length : newline);
		const looksLikeAddition =
			!normalized.text.includes(missing.token.normalized) &&
			(operation.rewrite === "" || operation.rewrite.includes(missing.token.text));
		const additionText = operation.rewrite === "" ? missing.token.text : operation.rewrite;
		return {
			reason:
				`Failed fragment: ${displayFragment(missing.token.text)} has 0 occurrences.` +
				(anchor ? ` It broke relative to matched anchor ${displayFragment(anchor.token.text)}.` : ""),
			previewOffset: anchorOffset ?? closest.offset,
			correctedPattern,
			additionRetry:
				looksLikeAddition && neighborLine.trim() !== ""
					? `If you are ADDING this text: match the existing neighbor line it belongs next to, and put the new text in the REWRITE —\n${OPENER}\n${SELECT_OPEN}${SELECT_CLOSE}${neighborLine}\n${REWRITE_HEADER}\n${additionText}`
					: undefined,
		};
	}

	let broken:
		| {
				left: (typeof literals)[number];
				right: (typeof literals)[number];
		  }
		| undefined;
	let reachable = literals[0]?.occurrences ?? [];
	for (let index = 1; index < literals.length; index++) {
		const left = literals[index - 1];
		const right = literals[index];
		const nextReachable = right.occurrences.filter(rightOccurrence =>
			pairCanAlign(content, normalized, pattern, left.index, right.index, reachable, [rightOccurrence]),
		);
		if (nextReachable.length === 0) {
			broken = { left, right };
			break;
		}
		reachable = nextReachable;
	}
	broken ??= literals.length >= 2 ? { left: literals.at(-2)!, right: literals.at(-1)! } : undefined;
	if (!broken) {
		const only = literals[0];
		return {
			reason: `Failed fragment: ${displayFragment(only?.token.text ?? operation.patternText)} could not align.`,
			previewOffset: only?.occurrences[0] ? sourceStart(normalized, only.occurrences[0].start, 0) : 0,
			correctedPattern: operation.patternText,
		};
	}

	const between = pattern.tokens.slice(broken.left.index + 1, broken.right.index);
	const rightAt = operation.patternText.indexOf(
		broken.right.token.text,
		operation.patternText.indexOf(broken.left.token.text) + broken.left.token.text.length,
	);
	const correctedPattern =
		between.some(token => token.kind === "gap") || rightAt < 0
			? operation.patternText
			: `${operation.patternText.slice(0, rightAt)}${GAP}${operation.patternText.slice(rightAt)}`;
	return {
		reason: `Ordered pair broke: ${displayFragment(broken.left.token.text)} did not precede ${displayFragment(broken.right.token.text)} as written.`,

		previewOffset: sourceStart(normalized, broken.left.occurrences[0]?.start ?? 0, 0),
		correctedPattern,
	};
}
function nonConsecutiveGuidance(
	content: string,
	operation: Operation,
): { locations: number[]; correctedPattern: string; previewOffset: number } | undefined {
	if (
		operation.patternText.includes(SELECT_OPEN) ||
		operation.patternText.includes(SELECT_CLOSE) ||
		operation.patternText.includes(GAP)
	) {
		return undefined;
	}
	const authoredLines = operation.patternText.split("\n").filter(line => line.trim() !== "");
	if (authoredLines.length < 2) return undefined;
	const fileLines = content.split("\n");
	const locations: number[] = [];
	let from = 0;
	for (const authoredLine of authoredLines) {
		const normalizedAuthored = normalizeText(authoredLine).text;
		let found = -1;
		for (let index = from; index < fileLines.length; index++) {
			if (normalizeText(fileLines[index]).text === normalizedAuthored) {
				found = index;
				break;
			}
		}
		if (found === -1) return undefined;
		locations.push(found + 1);
		from = found + 1;
	}
	if (locations.every((line, index) => index === 0 || line === locations[index - 1] + 1)) return undefined;
	const previewLine = Math.max(0, locations[0] - 1);
	const previewOffset = fileLines.slice(0, previewLine).reduce((sum, line) => sum + line.length + 1, 0);
	return {
		locations,
		correctedPattern: authoredLines.join(`\n${GAP}\n`),
		previewOffset,
	};
}

function rewriteIsIdenticalForAll(pattern: ParsedPattern, operation: Operation, candidates: Candidate[]): boolean {
	let rewriteGapCount = 0;
	for (let index = 0; index < operation.rewrite.length; ) {
		const marker = operation.rewrite.startsWith(GAP, index) ? GAP : undefined;
		if (marker) {
			rewriteGapCount++;
			index += marker.length;
			continue;
		}
		const codePoint = operation.rewrite.codePointAt(index);
		if (codePoint === undefined) break;
		index += String.fromCodePoint(codePoint).length;
	}
	const captures = pattern.selectedCaptureIndices.slice(0, rewriteGapCount);
	return captures.every(captureIndex =>
		candidates.every(candidate => candidate.captures[captureIndex] === candidates[0]?.captures[captureIndex]),
	);
}

function locate(
	content: string,
	pattern: ParsedPattern,
	operation: Operation,
	operationNumber: number,
	path: string,
): Candidate[] {
	const normalized = normalizeText(content);
	if (pattern.literalFallback) {
		const exact = exactOccurrences(normalized.text, pattern.literalFallback.normalized);
		if (exact.length > 0 && (operation.all || exact.length === 1)) {
			const fallbackCandidates = exact.map(occurrence => {
				const matchStart = sourceStart(normalized, occurrence.start, 0);
				const matchEnd = sourceEnd(normalized, occurrence.end, content.length);
				const fallbackStart = occurrence.start + pattern.literalFallback!.selectionStart;
				const fallbackEnd = occurrence.start + pattern.literalFallback!.selectionEnd;
				return {
					start:
						pattern.literalFallback!.selectionStart === pattern.literalFallback!.normalized.length
							? matchEnd
							: sourceStart(normalized, fallbackStart, matchEnd),
					end:
						pattern.literalFallback!.selectionEnd === pattern.literalFallback!.normalized.length
							? matchEnd
							: pattern.literalFallback!.insertion
								? sourceStart(normalized, fallbackEnd, matchEnd)
								: sourceEnd(normalized, fallbackEnd, matchEnd),
					matchStart,
					matchEnd,
					captures: [],
					selectionSpans: [],
					tuple: [occurrence.start],
				};
			});
			return operation.all ? fallbackCandidates : [fallbackCandidates[0]];
		}
	}
	let result = collectCandidates(content, normalized, pattern, false);
	if (result.candidates.length === 0 && !result.overflow) {
		result = collectCandidates(content, normalized, pattern, true);
		if (result.candidates.length === 0 && !result.overflow && !operation.all) {
			const punctuationTolerant = collectCandidates(content, normalized, pattern, true, true);
			if (!punctuationTolerant.overflow && punctuationTolerant.candidates.length === 1) {
				result = punctuationTolerant;
			}
		}
	}
	if (result.overflow) {
		throw new Error(`Operation ${operationNumber} pattern is too broad; add another distinctive ${GAP} fragment.`);
	}
	const candidates = result.candidates;
	if (operation.all && candidates.length > 0) return candidates;
	if (candidates.length === 1) return [candidates[0]];
	if (candidates.length === 0) {
		const separated = nonConsecutiveGuidance(content, operation);
		if (separated) {
			const header = operation.all ? `${OPENER}*` : OPENER;
			throw new Error(
				[
					`Operation ${operationNumber} did not match ${path}: your lines match individually at lines ${separated.locations.join(", ")} but are not consecutive.`,
					"Copy-ready corrected operation:",
					`${header}\n${separated.correctedPattern}\n${REWRITE_HEADER}\n${operation.rewrite}`,
					`The REWRITE then replaces the whole span lines ${separated.locations[0]}-${separated.locations.at(-1)}, including the skipped lines — re-emit kept gaps with ${GAP}.`,
				].join("\n"),
			);
		}
		const guidance = noMatchGuidance(content, normalized, pattern, operation);
		throw new Error(
			[
				operation.all
					? `Operation ${operationNumber} ${OPENER}* found 0 matches in ${path}. ${guidance.reason}`
					: `Operation ${operationNumber} did not match ${path}. ${guidance.reason}`,
				"Current file content near the closest match (no re-read needed):",
				numberedPreview(content, guidance.previewOffset),
				"Copy-ready corrected operation:",
				`${operation.all ? `${OPENER}*` : OPENER}\n${guidance.correctedPattern}\n${REWRITE_HEADER}\n${operation.rewrite}`,
				...(guidance.additionRetry ? [guidance.additionRetry] : []),
			].join("\n"),
		);
	}
	const retries = candidates.slice(0, 2).map(candidate => {
		const line = lineNumberAt(content, candidate.start);
		const distinguishing = distinguishingContext(content, candidate, candidates);
		const pattern = !distinguishing
			? operation.patternText
			: distinguishing.side === "before"
				? `${distinguishing.line}${GAP}\n${operation.patternText}`
				: `${operation.patternText}\n${GAP}\n${distinguishing.line}`;
		return `Near line ${line}:\n${OPENER}\n${pattern}\n${REWRITE_HEADER}\n${operation.rewrite}`;
	});
	const allRetry = rewriteIsIdenticalForAll(pattern, operation, candidates)
		? `All candidates receive the same rewrite; retry every match:\n${operationPayload(operation, "*")}\n\n`
		: "";
	throw new Error(
		`Operation ${operationNumber} is ambiguous: ${candidates.length} ordered tuples match.\n\n${allRetry}Add context that only the intended match has — one of these:\n\n${retries.join("\n\n")}`,
	);
}

/**
 * A nearby line that only this candidate has — searched above first, then
 * below. Because gaps span freely, an anchor only disambiguates when it does
 * not also sit on the same side of every other candidate. Turns an ambiguous
 * pattern into a unique one for one line plus a gap: cheaper than an ordinal
 * and impossible to misread as an operation index.
 */
function distinguishingContext(
	content: string,
	candidate: Candidate,
	all: Candidate[],
): { side: "before" | "after"; line: string } | undefined {
	const others = all.filter(entry => entry.start !== candidate.start);
	const usable = (line: string | undefined): line is string =>
		line !== undefined && line.length >= 3 && /[\p{L}\p{N}_$]/u.test(line);

	const before = content
		.slice(0, candidate.start)
		.split("\n")
		.map(line => line.trim());
	const othersBefore = others.map(entry =>
		content
			.slice(0, entry.start)
			.split("\n")
			.map(line => line.trim()),
	);
	for (let back = 2; back <= 12 && back <= before.length; back++) {
		const line = before[before.length - back];
		if (!usable(line)) continue;
		if (othersBefore.every(lines => !lines.includes(line))) return { side: "before", line };
	}

	const after = content
		.slice(candidate.end)
		.split("\n")
		.map(line => line.trim());
	const othersAfter = others.map(entry =>
		content
			.slice(entry.end)
			.split("\n")
			.map(line => line.trim()),
	);
	for (let forward = 0; forward < 12 && forward < after.length; forward++) {
		const line = after[forward];
		if (!usable(line)) continue;
		if (othersAfter.every(lines => !lines.includes(line))) return { side: "after", line };
	}
	return undefined;
}

function commonIndent(lines: string[]): number {
	let minimum = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.trim() === "") continue;
		minimum = Math.min(minimum, line.length - line.trimStart().length);
	}
	return minimum === Number.POSITIVE_INFINITY ? 0 : minimum;
}

function spaceIndentUnit(content: string): number {
	let unit = 0;
	for (const line of content.split("\n")) {
		const indent = line.match(/^ +/)?.[0].length ?? 0;
		if (indent === 0) continue;
		let left = unit;
		let right = indent;
		while (right !== 0) {
			const remainder = left % right;
			left = right;
			right = remainder;
		}
		unit = left;
	}
	return unit || 4;
}

function adaptRelativeIndent(line: string, fileIndent: string, spaceUnit: number): string {
	const indent = line.match(/^[ \t]+/)?.[0] ?? "";
	if (indent === "") return line;
	const rest = line.slice(indent.length);
	if (fileIndent === "\t" && !indent.includes("\t")) {
		const levels = Math.max(1, Math.round(indent.length / Math.max(1, spaceUnit)));
		return "\t".repeat(levels) + rest;
	}
	if (fileIndent === " " && indent.includes("\t") && !indent.includes(" ")) {
		return " ".repeat(indent.length * spaceUnit) + rest;
	}
	return line;
}

function reindentReplacement(content: string, start: number, replacement: string): string {
	if (replacement === "") return replacement;
	const lineStart = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const baseIndent = content.slice(lineStart, start);
	if (!/^[ \t]*$/.test(baseIndent)) return replacement;
	const lines = replacement.split("\n");
	const remove = commonIndent(lines);
	const stripped = lines.map(line => (line.trim() === "" ? "" : line.slice(Math.min(remove, line.length))));
	const fileIndent = baseIndent[0] ?? detectIndentChar(content);
	const unit = spaceIndentUnit(content);
	return stripped
		.map((line, index) => {
			const adapted = adaptRelativeIndent(line, fileIndent, unit);
			if (index === 0) return adapted;
			if (line === "" && index < stripped.length - 1) return "";
			return baseIndent + adapted;
		})
		.join("\n");
}

function hasIndentAdoptionEvidence(content: string, candidate: Candidate, replacement: string): boolean {
	if (replacement === "") return false;
	const sourceLineStart = content.lastIndexOf("\n", Math.max(0, candidate.matchStart - 1)) + 1;
	const sourceLines = content.slice(sourceLineStart, candidate.matchEnd).split("\n");
	const rewriteLines = replacement.split("\n");
	const deltas: number[] = [];
	let sourceIndex = 0;
	for (const rewriteLine of rewriteLines) {
		if (rewriteLine.trim() === "") continue;
		let aligned = -1;
		for (let index = sourceIndex; index < sourceLines.length; index++) {
			if (sourceLines[index].trim() === rewriteLine.trim()) {
				aligned = index;
				break;
			}
		}
		if (aligned === -1) continue;
		const sourceIndent = sourceLines[aligned].length - sourceLines[aligned].trimStart().length;
		const rewriteIndent = rewriteLine.length - rewriteLine.trimStart().length;
		deltas.push(sourceIndent - rewriteIndent);
		sourceIndex = aligned + 1;
	}
	const repeatedBoundaryAnchor =
		sourceLines.length === 1 &&
		rewriteLines.filter(line => line.trim() !== "").length >= 2 &&
		commonIndent(rewriteLines) === 0 &&
		deltas.length === 1 &&
		deltas[0] > 0 &&
		(rewriteLines[0]?.trim() === sourceLines[0].trim() || rewriteLines.at(-1)?.trim() === sourceLines[0].trim());
	return repeatedBoundaryAnchor || (deltas.length >= 2 && deltas[0] > 0 && deltas.every(delta => delta === deltas[0]));
}

function renderRewrite(
	content: string,
	start: number,
	rewrite: string,
	selectedCaptureIndices: number[],
	captures: string[],
	operationNumber: number,
	adoptIndent: boolean,
): string {
	if (rewrite.includes(SELECT_OPEN) || rewrite.includes(SELECT_CLOSE)) {
		throw new Error(
			`Operation ${operationNumber} has selection markers in REWRITE; PATTERN is current text, REWRITE is final text.`,
		);
	}
	const sentinels = selectedCaptureIndices.map((_, index) => `\u0000V8GAP${index}\u0000`);
	let markerIndex = 0;
	let marked = "";
	for (let index = 0; index < rewrite.length; ) {
		const gapMarker = rewrite.startsWith(GAP, index) ? GAP : undefined;
		if (gapMarker) {
			marked += markerIndex < sentinels.length ? sentinels[markerIndex] : gapMarker;
			markerIndex++;
			index += gapMarker.length;
			continue;
		}
		const codePoint = rewrite.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		marked += character;
		index += character.length;
	}
	const indent = (value: string) => (adoptIndent ? reindentReplacement(content, start, value) : value);
	if (markerIndex === 0 || sentinels.length === 0) return indent(marked);
	let rendered = indent(marked);
	for (let index = 0; index < sentinels.length; index++) {
		const sentinel = sentinels[index];
		const capture = captures[selectedCaptureIndices[index]] ?? "";
		const sentinelAt = rendered.indexOf(sentinel);
		if (sentinelAt === -1) continue;
		let before = rendered.slice(0, sentinelAt);
		let after = rendered.slice(sentinelAt + sentinel.length);
		if (/^\s/u.test(capture) && /\s$/u.test(before)) before = before.replace(/\s+$/u, "");
		if (/\s$/u.test(capture) && /^\s/u.test(after)) after = after.replace(/^\s+/u, "");
		rendered = before + capture + after;
	}
	return rendered;
}

function alignBoundaryEchoes(content: string, candidate: Candidate, replacement: string): string {
	if (replacement === "" || (candidate.start === candidate.matchStart && candidate.end === candidate.matchEnd)) {
		return replacement;
	}
	const prefix = content.slice(candidate.matchStart, candidate.start);
	const suffix = content.slice(candidate.end, candidate.matchEnd);
	const normalizedReplacement = normalizeText(replacement);
	const normalizedPrefix = normalizeText(prefix).text;
	const normalizedSuffix = normalizeText(suffix).text;
	const prefixEcho = normalizedPrefix.length >= 3 && normalizedReplacement.text.startsWith(normalizedPrefix);
	const suffixEcho =
		normalizedSuffix.length > 0 &&
		normalizedReplacement.text.endsWith(normalizedSuffix) &&
		(normalizedSuffix.length >= 3 || prefixEcho);
	if (!prefixEcho && !suffixEcho) return replacement;

	let from = 0;
	let to = replacement.length;
	if (prefixEcho) {
		from = replacement.startsWith(prefix)
			? prefix.length
			: sourceEnd(normalizedReplacement, normalizedPrefix.length, replacement.length);
	}
	if (suffixEcho) {
		to = replacement.endsWith(suffix)
			? replacement.length - suffix.length
			: sourceStart(
					normalizedReplacement,
					normalizedReplacement.text.length - normalizedSuffix.length,
					replacement.length,
				);
	}
	if (from > to) return replacement;
	let aligned = replacement.slice(from, to);
	if (/\s$/u.test(prefix) && /^\s/u.test(aligned)) aligned = aligned.replace(/^\s+/u, "");
	if (/^\s/u.test(suffix) && /\s$/u.test(aligned)) aligned = aligned.replace(/\s+$/u, "");
	return aligned;
}

function expandFullLineDeletion(content: string, candidate: Candidate): Candidate {
	if (candidate.start === candidate.end) return candidate;
	const lineStart = content.lastIndexOf("\n", Math.max(0, candidate.start - 1)) + 1;
	const newline = content.indexOf("\n", candidate.end);
	const lineEnd = newline === -1 ? content.length : newline;
	if (
		!/^[ \t]*$/.test(content.slice(lineStart, candidate.start)) ||
		!/^[ \t]*$/.test(content.slice(candidate.end, lineEnd))
	) {
		return candidate;
	}
	let end = newline === -1 ? lineEnd : newline + 1;
	if (lineStart > 0 && end < content.length) {
		const previousEnd = lineStart - 1;
		const previousStart = content.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
		const nextEnd = content.indexOf("\n", end);
		const previousBlank = content.slice(previousStart, previousEnd).trim() === "";
		const nextBlank = content.slice(end, nextEnd === -1 ? content.length : nextEnd).trim() === "";
		if (previousBlank && nextBlank) end = nextEnd === -1 ? content.length : nextEnd + 1;
	}
	return { ...candidate, start: lineStart, end };
}

function positionalRewriteSegments(rewrite: string, count: number, patternHasGaps: boolean): string[] | undefined {
	const lines = rewrite.split("\n");
	const isWholeLineGap = (line: string) => line.trim() === GAP;
	const hasWholeLineGap = lines.some(isWholeLineGap);
	if (hasWholeLineGap) {
		if (patternHasGaps) return undefined;
		const groups: string[][] = [[]];
		for (const line of lines) {
			if (isWholeLineGap(line)) {
				groups.push([]);
			} else {
				groups.at(-1)?.push(line);
			}
		}
		if (groups.length === count) return groups.map(group => group.join("\n"));
		return undefined;
	}
	if (lines.length === count) return lines;
	if (!rewrite.includes("\n")) {
		const segments = rewrite.split(GAP);
		if (segments.length === count) return segments;
	}
	return undefined;
}

function prepareCandidateEdit(
	content: string,
	candidate: Candidate,
	pattern: ParsedPattern,
	operation: Operation,
	rewrite: string,
	operationNumber: number,
): { candidate: Candidate; replacement: string; deletedText: string | undefined } {
	const lineStart = content.lastIndexOf("\n", Math.max(0, candidate.start - 1)) + 1;
	const leadingSourceWhitespace = content.slice(lineStart, candidate.start);
	const controlsWholeIndent =
		!(operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE)) &&
		/^[ \t]*$/u.test(leadingSourceWhitespace);
	const authoredStart = controlsWholeIndent ? lineStart : candidate.start;
	const authoredSource = content.slice(authoredStart, candidate.end);
	const whitespaceOnly =
		authoredSource !== rewrite && normalizeText(authoredSource).text === normalizeText(rewrite).text;
	const adoptIndent =
		!whitespaceOnly &&
		!(operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE)) &&
		hasIndentAdoptionEvidence(content, candidate, rewrite);
	if (controlsWholeIndent && !adoptIndent && lineStart < candidate.start) {
		candidate = { ...candidate, start: lineStart, matchStart: Math.min(lineStart, candidate.matchStart) };
	}
	let replacement = renderRewrite(
		content,
		candidate.start,
		rewrite,
		candidate.captures.length === 0 ? [] : pattern.selectedCaptureIndices,
		candidate.captures,
		operationNumber,
		adoptIndent || operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE),
	);
	replacement = alignBoundaryEchoes(content, candidate, replacement);
	let deletedText: string | undefined;
	if (replacement === "") {
		deletedText = content.slice(candidate.start, candidate.end);
		candidate = expandFullLineDeletion(content, candidate);
	}
	return { candidate, replacement, deletedText };
}

function wouldChangeHint(
	content: string,
	chosen: Candidate,
	pattern: ParsedPattern,
	operation: Operation,
	rewrite: string,
	operationNumber: number,
): string | undefined {
	const alternatives = exactAndFuzzyCandidates(content, pattern);
	if (alternatives.overflow) return undefined;
	for (let index = 0; index < alternatives.candidates.length; index++) {
		const alternative = alternatives.candidates[index];
		if (
			alternative.start === chosen.start &&
			alternative.end === chosen.end &&
			alternative.matchStart === chosen.matchStart &&
			alternative.matchEnd === chosen.matchEnd
		) {
			continue;
		}
		const prepared = prepareCandidateEdit(content, alternative, pattern, operation, rewrite, operationNumber);
		if (content.slice(prepared.candidate.start, prepared.candidate.end) === prepared.replacement) continue;
		const line = lineNumberAt(content, prepared.candidate.start);
		return `Line ${line} also matches and WOULD change — target it by adding context unique to it.`;
	}
	return undefined;
}

function positionalWouldChangeHint(
	content: string,
	chosen: Candidate,
	pattern: ParsedPattern,
	operation: Operation,
	replacements: string[],
): string | undefined {
	const alternatives = exactAndFuzzyCandidates(content, pattern);
	if (alternatives.overflow) return undefined;
	for (let index = 0; index < alternatives.candidates.length; index++) {
		const alternative = alternatives.candidates[index];
		if (
			alternative.start === chosen.start &&
			alternative.end === chosen.end &&
			alternative.matchStart === chosen.matchStart &&
			alternative.matchEnd === chosen.matchEnd
		) {
			continue;
		}
		const changes = alternative.selectionSpans.some(
			(span, selectionIndex) => content.slice(span.start, span.end) !== replacements[selectionIndex],
		);
		if (!changes) continue;
		const line = lineNumberAt(content, alternative.start);
		return `Line ${line} also matches and WOULD change — target it by adding context unique to it.`;
	}
	return undefined;
}

function rewriteProvesWholeSpan(content: string, candidate: Candidate, rewrite: string): boolean {
	const normalizedRewrite = normalizeText(rewrite).text;
	const contexts = candidate.selectionSpans
		.slice(0, -1)
		.map((span, index) => normalizeText(content.slice(span.end, candidate.selectionSpans[index + 1].start)).text)
		.filter(context => context !== "");
	if (contexts.length === 0) return false;
	let from = 0;
	for (const context of contexts) {
		const found = normalizedRewrite.indexOf(context, from);
		if (found === -1) return false;
		from = found + context.length;
	}
	return true;
}

function rewriteSelectionSpans(content: string, candidate: Candidate, replacements: string[]): string {
	let rewritten = content.slice(candidate.start, candidate.end);
	const indexed = candidate.selectionSpans
		.map((span, index) => ({ span, replacement: replacements[index] }))
		.sort((left, right) => right.span.start - left.span.start);
	for (const { span, replacement } of indexed) {
		const start = span.start - candidate.start;
		const end = span.end - candidate.start;
		rewritten = rewritten.slice(0, start) + replacement + rewritten.slice(end);
	}
	return rewritten;
}

/**
 * Merge two overlapping planned edits when they agree. Each edit is applied
 * independently to the union span; identical results mean the payload is
 * consistent (typically a `«*` rename plus a narrower op over one of its
 * matches), so one merged edit replaces both. Disagreement returns undefined
 * and the caller reports the conflict.
 */
function reconcileOverlap(content: string, left: PlannedEdit, right: PlannedEdit): PlannedEdit | undefined {
	const start = Math.min(left.start, right.start);
	const end = Math.max(left.end, right.end);
	const project = (edit: PlannedEdit): string =>
		content.slice(start, edit.start) + edit.replacement + content.slice(edit.end, end);
	const projected = project(left);
	if (projected !== project(right)) return undefined;
	return { start, end, replacement: projected, operationNumber: left.operationNumber };
}

function applyOperations(content: string, input: string, context: SloppyApplyContext): string {
	let payloadHash = 2166136261;
	for (let index = 0; index < input.length; index++) {
		payloadHash ^= input.charCodeAt(index);
		payloadHash = Math.imul(payloadHash, 16777619);
	}
	const hash = (payloadHash >>> 0).toString(16);
	if (noOpByPath.get(context.path)?.hash !== hash) noOpByPath.delete(context.path);
	const throwNoOp = (
		operationNumber?: number,
		preview?: { content: string; offset: number },
		matchCount?: number,
		hint?: string,
	): never => {
		const previous = noOpByPath.get(context.path);
		const count = previous?.hash === hash ? previous.count + 1 : 1;
		noOpByPath.set(context.path, { hash, count });
		const base =
			count >= 3
				? `STOP: identical no-op repeated ${count} times for ${context.path}. Re-read current code and send a changed payload, or move on.`
				: operationNumber === undefined
					? `Edits to ${context.path} made no change.`
					: matchCount === undefined
						? `Operation ${operationNumber} makes no change to ${context.path}.`
						: `Operation ${operationNumber} ${OPENER}* matched ${matchCount} occurrences but all make no change to ${context.path}.`;
		const grounding = preview
			? `\nYour rewrite normalized to text identical to these lines. Indentation-only changes are applied verbatim; adjust the authored REWRITE if another whitespace change was intended.\nCurrent file content near the closest match (no re-read needed):\n${numberedPreview(preview.content, preview.offset)}`
			: "";
		throw new Error(base + grounding + (hint ? `\n${hint}` : ""));
	};

	let operations: Operation[];
	try {
		operations = parseOperations(input, content);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const normalizedPayload = normalizeInput(input);
		const retry =
			parseOpener(normalizedPayload.split("\n")[0] ?? "") === false
				? `${OPENER}\n${normalizedPayload}`
				: normalizedPayload;
		throw new Error(`${error.message}\nCopy-ready corrected payload:\n${retry}`);
	}
	const removedByOperation: Array<string | undefined> = [];
	const planned: PlannedEdit[] = [];
	let lastMatchOffset = 0;
	for (let index = 0; index < operations.length; index++) {
		const operationNumber = index + 1;
		const operation = operations[index];
		const pattern = parsePattern(operation.patternText, operationNumber);
		const candidates = locate(content, pattern, operation, operationNumber, context.path);
		const orderedCandidates = operation.all
			? [...candidates].sort((left, right) => right.start - left.start)
			: candidates;
		const loneReference = operation.rewrite.match(/^[ \t]*»([1-9]\d*)[ \t]*$/u);
		const resolvedRewrite = operation.rewrite
			.split("\n")
			.map(line => {
				const reference = line.trim().match(/^»([1-9]\d*)$/u);
				if (!reference) return line;
				const referenced = removedByOperation[Number(reference[1]) - 1];
				if (referenced === undefined) {
					throw new Error(`${REWRITE_HEADER}${reference[1]} must reference an earlier deletion operation.`);
				}
				return referenced;
			})
			.join("\n");
		const baseResolvedRewrite = resolvedRewrite.trim() === "" ? (pattern.insertion ? "\n" : "") : resolvedRewrite;
		if (pattern.selectionRanges.length > 1) {
			const segments = positionalRewriteSegments(
				baseResolvedRewrite,
				pattern.selectionRanges.length,
				pattern.tokens.some(token => token.kind === "gap"),
			);
			if (segments) {
				let positionalChanges = 0;
				for (const candidate of orderedCandidates) {
					const selections = candidate.selectionSpans
						.map((span, selectionIndex) => ({ span, replacement: segments[selectionIndex] }))
						.sort((left, right) => right.span.start - left.span.start);
					for (const { span, replacement } of selections) {
						if (content.slice(span.start, span.end) === replacement) continue;
						planned.push({ ...span, replacement, operationNumber });
						positionalChanges++;
					}
					lastMatchOffset = candidate.matchStart;
				}
				if (positionalChanges === 0) {
					const hint = positionalWouldChangeHint(content, candidates[0], pattern, operation, segments);
					throwNoOp(
						operationNumber,
						{ content, offset: candidates[0].matchStart },
						operation.all ? candidates.length : undefined,
						hint,
					);
				}
				continue;
			}
			if (!candidates.every(candidate => rewriteProvesWholeSpan(content, candidate, baseResolvedRewrite))) {
				const candidate = candidates[0];
				const oneLineRewrite = baseResolvedRewrite.replace(/\s*\n\s*/gu, " ");
				const repeated = new Array<string>(pattern.selectionRanges.length).fill(oneLineRewrite);
				const header = operation.all ? `${OPENER}*` : OPENER;
				throw new Error(
					[
						`Operation ${operationNumber} has ${pattern.selectionRanges.length} selections, but REWRITE proves neither positional substitution nor whole-span replacement.`,
						"Copy-ready per-selection interpretation:",
						`${header}\n${operation.patternText}\n${REWRITE_HEADER}\n${repeated.join("\n")}`,
						"Copy-ready whole-span interpretation:",
						`${header}\n${operation.patternText}\n${REWRITE_HEADER}\n${rewriteSelectionSpans(content, candidate, repeated)}`,
					].join("\n"),
				);
			}
		}
		let changes = 0;
		for (const located of orderedCandidates) {
			let candidate = located;
			let resolvedRewrite = baseResolvedRewrite;
			if (loneReference && !operation.all) {
				const referenced = removedByOperation[Number(loneReference[1]) - 1];
				const anchorLineStart = content.lastIndexOf("\n", Math.max(0, candidate.matchStart - 1)) + 1;
				const anchorNewline = content.indexOf("\n", candidate.matchEnd);
				const anchorLineEnd = anchorNewline === -1 ? content.length : anchorNewline;
				const anchorLine = content.slice(anchorLineStart, anchorLineEnd);
				const singleWholeLine =
					!pattern.insertion &&
					anchorLine.trim() !== "" &&
					!content.slice(candidate.matchStart, candidate.matchEnd).includes("\n") &&
					/^[ \t]*$/u.test(content.slice(anchorLineStart, candidate.matchStart)) &&
					/^[ \t]*$/u.test(content.slice(candidate.matchEnd, anchorLineEnd));
				const anchorNormalized = normalizeText(anchorLine).text;
				if (
					referenced !== undefined &&
					singleWholeLine &&
					anchorNormalized !== "" &&
					!normalizeText(referenced).text.includes(anchorNormalized)
				) {
					resolvedRewrite = `${referenced.replace(/\n+$/u, "")}\n\n${anchorLine}`;
				}
			}
			const rewrite =
				pattern.lineInsertion && resolvedRewrite !== "" && !resolvedRewrite.endsWith("\n")
					? `${resolvedRewrite}\n`
					: resolvedRewrite;
			const prepared = prepareCandidateEdit(content, candidate, pattern, operation, rewrite, operationNumber);
			candidate = prepared.candidate;
			const replacement = prepared.replacement;
			if (prepared.deletedText !== undefined && candidates.length === 1) {
				removedByOperation[index] = prepared.deletedText;
			}
			lastMatchOffset = candidate.matchStart;
			if (content.slice(candidate.start, candidate.end) === replacement) {
				if (operation.all) continue;
				const hint =
					loneReference === null
						? wouldChangeHint(content, located, pattern, operation, rewrite, operationNumber)
						: undefined;
				throwNoOp(operationNumber, { content, offset: candidate.matchStart }, undefined, hint);
			}
			planned.push({ start: candidate.start, end: candidate.end, replacement, operationNumber });
			changes++;
		}
		if (operation.all && changes === 0) {
			const rewrite =
				pattern.lineInsertion && baseResolvedRewrite !== "" && !baseResolvedRewrite.endsWith("\n")
					? `${baseResolvedRewrite}\n`
					: baseResolvedRewrite;
			const hint =
				loneReference === null
					? wouldChangeHint(content, candidates[0], pattern, operation, rewrite, operationNumber)
					: undefined;
			throwNoOp(operationNumber, { content, offset: candidates[0].matchStart }, candidates.length, hint);
		}
	}
	if (planned.length === 0) throwNoOp(undefined, { content, offset: lastMatchOffset });
	const sorted = [...planned].sort((left, right) => left.start - right.start || left.end - right.end);
	const ordered: PlannedEdit[] = [];
	for (const current of sorted) {
		const previous = ordered.at(-1);
		const overlaps =
			previous !== undefined &&
			(current.start < previous.end ||
				(current.start === previous.start && (current.end === current.start || previous.end === previous.start)));
		if (!previous || !overlaps) {
			ordered.push(current);
			continue;
		}
		// Overlapping spans are only a conflict when they disagree. A broad
		// `«*` plus a narrower op over one of its matches (rename + the line
		// that contains it) produces byte-identical text for the shared
		// region — merge instead of rejecting a payload that is consistent.
		const merged = reconcileOverlap(content, previous, current);
		if (merged) {
			ordered[ordered.length - 1] = merged;
			continue;
		}
		const firstLine = lineNumberAt(content, previous.start);
		const secondLine = lineNumberAt(content, current.start);
		throw new Error(
			[
				`Operations ${previous.operationNumber} and ${current.operationNumber} target overlapping original spans near lines ${firstLine} and ${secondLine}.`,
				"Conflicting candidates:",
				`Operation ${previous.operationNumber} near line ${firstLine}:\n${OPENER}\n${operations[previous.operationNumber - 1].patternText}\n${REWRITE_HEADER}\n${operations[previous.operationNumber - 1].rewrite}`,
				`Operation ${current.operationNumber} near line ${secondLine}:\n${OPENER}\n${operations[current.operationNumber - 1].patternText}\n${REWRITE_HEADER}\n${operations[current.operationNumber - 1].rewrite}`,
				"Keep whichever states the intended final text and drop the other.",
			].join("\n\n"),
		);
	}
	let result = content;
	for (const edit of ordered.reverse()) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}
	if (result === content) throwNoOp(undefined, { content, offset: lastMatchOffset });
	noOpByPath.delete(context.path);
	return result;
}

function apply(content: string, input: string, context: SloppyApplyContext): string {
	try {
		return applyOperations(content, input, context);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		let message = error.message;
		if (
			!message.includes("Current file content near the closest match (no re-read needed):") &&
			!/\bNear line \d+:/u.test(message) &&
			!message.includes("Copy-ready corrected operation:") &&
			!message.includes("Copy-ready corrected payload:") &&
			!message.includes("Copy-ready per-selection interpretation:")
		) {
			message += `\nCurrent file content near the closest match (no re-read needed):\n${numberedPreview(content, 0)}`;
		}
		if (!message.includes(ATOMICITY_NOTICE)) message += `\n${ATOMICITY_NOTICE}`;
		throw new Error(message);
	}
}

/** The official sloppy implementation; docs re-skinned to the active marker alphabet. */
export const sloppyVariant: SloppyVariant = { id: "sloppy", description, apply };

/** Lark grammar for constrained decoding, in the active marker alphabet. */
export const sloppyGrammar: string = sloppyGrammarSource;

export interface ExecuteSloppyOptions {
	session: ToolSession;
	/** Payload sections with display paths already workspace-resolved. */
	sections: SloppySection[];
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

interface PreparedSloppySection {
	path: string;
	absolutePath: string;
	rawContent: string;
	bom: string;
	originalEnding: "\n" | "\r\n";
	normalizedContent: string;
	newContent: string;
}

/**
 * Execute a sloppy payload against its `[path]` sections. Hashline-style
 * all-or-nothing: every section is applied in memory first; a failure in any
 * section means no file is written. Mirrors `executeReplace`'s per-file
 * lifecycle (plan-mode guard, BOM/EOL preservation, LSP writethrough, diff
 * details); {@link sloppyVariant} owns payload parsing and matching.
 */
export async function executeSloppy(
	options: ExecuteSloppyOptions,
): Promise<AgentToolResult<EditToolDetails, SloppyParams>> {
	const { session, sections, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;
	const multiFile = sections.length > 1;

	// Phase 1 — preflight every section in memory; nothing is written unless all succeed.
	const prepared: PreparedSloppySection[] = [];
	for (const section of sections) {
		// Models copy read-tool selectors into paths (`file.ts:23`, `file.ts:grep=x`).
		// When the authored path is missing but the selector-less base exists, edit the base.
		let path = section.path;
		let absolutePath = resolvePlanPath(session, path);
		try {
			await Bun.file(absolutePath).stat();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const stripped = path.replace(/:[^/:]*$/, "");
			if (stripped && stripped !== path) {
				const strippedAbsolute = resolvePlanPath(session, stripped);
				try {
					await Bun.file(strippedAbsolute).stat();
					path = stripped;
					absolutePath = strippedAbsolute;
				} catch (strippedError) {
					if (!isEnoent(strippedError)) throw strippedError;
				}
			}
		}

		enforcePlanModeWrite(session, path);

		const rawContent = await readEditFileText(absolutePath, path);
		const { bom, text: fileText } = stripBom(rawContent);
		const originalEnding = detectLineEnding(fileText);
		const normalizedContent = normalizeToLF(fileText);

		let newContent: string;
		try {
			newContent = sloppyVariant.apply(normalizedContent, normalizeToLF(section.body), { path });
		} catch (error) {
			if (!(error instanceof Error) || !multiFile) throw error;
			throw new Error(`[${path}]: ${error.message}\nNo files were modified — sections apply atomically.`);
		}
		if (newContent === normalizedContent) {
			throw new Error(`Edits to ${path} resulted in no changes being made.`);
		}
		prepared.push({ path, absolutePath, rawContent, bom, originalEnding, normalizedContent, newContent });
	}

	// Phase 2 — write every prepared section; only the last write flushes the LSP batch.
	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let firstChangedLine: number | undefined;
	for (let index = 0; index < prepared.length; index++) {
		const entry = prepared[index];
		const isLast = index === prepared.length - 1;
		const sectionBatch: LspBatchRequest | undefined = batchRequest
			? { id: batchRequest.id, flush: isLast && batchRequest.flush }
			: undefined;
		const finalContent = await serializeEditFileText(
			entry.absolutePath,
			entry.path,
			entry.bom + restoreLineEndings(entry.newContent, entry.originalEnding),
		);

		// Route through ACP bridge when available; skips internal artifacts.
		let diagnostics: FileDiagnosticsResult | undefined;
		if (await routeWriteThroughBridge(session, entry.path, entry.absolutePath, finalContent, signal)) {
			// bridge handled the write; diagnostics not available via writethrough
		} else {
			diagnostics = await writethrough(
				entry.absolutePath,
				finalContent,
				signal,
				Bun.file(entry.absolutePath),
				sectionBatch,
				dst => (dst === entry.absolutePath ? beginDeferredDiagnosticsForPath(entry.absolutePath) : undefined),
			);
			invalidateFsScanAfterWrite(entry.absolutePath);
		}

		const diffResult = generateDiffString(entry.normalizedContent, entry.newContent, undefined, { path: entry.path });
		const meta = outputMeta()
			.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
			.get();
		firstChangedLine ??= diffResult.firstChangedLine;
		contentTexts.push(`Successfully edited ${entry.path}.`);
		perFileResults.push({
			path: entry.absolutePath,
			diff: diffResult.diff,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: entry.rawContent,
			newText: finalContent,
		});
	}

	if (!multiFile) {
		const only = perFileResults[0];
		return {
			content: [{ type: "text", text: contentTexts[0] }],
			details: pruneOversizedEditSnapshots({
				diff: only.diff,
				path: only.path,
				firstChangedLine: only.firstChangedLine,
				diagnostics: only.diagnostics,
				meta: only.meta,
				oldText: only.oldText,
				newText: only.newText,
			}),
		};
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(entry => entry.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine,
			perFileResults,
		}),
	};
}
