#!/usr/bin/env python3
"""One-off patcher for #4218, applied by a temporary workflow and then removed.

Performs exact-string replacements with occurrence-count assertions so a
drifted base fails loudly instead of mispatching.
"""

import pathlib
import sys


def patch(path: str, replacements: list[tuple[str, str]]) -> None:
	target = pathlib.Path(path)
	text = target.read_text(encoding="utf-8")
	for old, new in replacements:
		count = text.count(old)
		if count != 1:
			print(f"FATAL: expected exactly 1 occurrence in {path}, found {count}:\n{old}", file=sys.stderr)
			sys.exit(1)
		text = text.replace(old, new)
	target.write_text(text, encoding="utf-8")
	print(f"patched {path}")


EVIDENCE_LOG = (
	"\t\t\t\t\t\tif (trailerError) {\n"
	"\t\t\t\t\t\t\t// #4218: these rejections carry no HTTP error body, so the raw\n"
	"\t\t\t\t\t\t\t// trailer is the only server-side evidence. Log it with the\n"
	"\t\t\t\t\t\t\t// request shape before classification discards it.\n"
	'\t\t\t\t\t\t\tlogger.warn("devin: stream rejected via Connect trailer", {\n'
	"\t\t\t\t\t\t\t\tmodel: model.id,\n"
	"\t\t\t\t\t\t\t\tcode: trailerError.code,\n"
	"\t\t\t\t\t\t\t\tmessage: trailerError.message,\n"
	"\t\t\t\t\t\t\t\t...(trailerError.detail ? { detail: trailerError.detail } : {}),\n"
	"\t\t\t\t\t\t\t\trawTrailer: trailerError.raw,\n"
	"\t\t\t\t\t\t\t\trequestBytes: reqBytes.byteLength,\n"
	"\t\t\t\t\t\t\t\tcompressedBytes: gz.byteLength,\n"
	"\t\t\t\t\t\t\t\ttools: context.tools?.length ?? 0,\n"
	"\t\t\t\t\t\t\t\tmessages: context.messages.length,\n"
	"\t\t\t\t\t\t\t\thadOutput: firstTokenTime !== undefined,\n"
	"\t\t\t\t\t\t\t});\n"
	"\t\t\t\t\t\t\tconst error = new AIError.ValidationError(trailerError.formatted);\n"
)

NEW_INTERFACE = (
	"interface ConnectTrailerError {\n"
	"\tcode: string;\n"
	"\tmessage: string;\n"
	"\tformatted: string;\n"
	"\t/** Summarized Connect error details entries, when the trailer carried any. */\n"
	"\tdetail?: string;\n"
	"\t/** Raw trailer JSON (truncated) retained for evidence logging; see #4218. */\n"
	"\traw: string;\n"
	"}\n"
)

NEW_TAIL = (
	"\tif (!code && !message) return null;\n"
	"\tconst trailer: ConnectTrailerError = {\n"
	"\t\tcode,\n"
	"\t\tmessage,\n"
	"\t\tformatted: `Devin stream error${code ? ` ${code}` : \"\"}: ${message}`,\n"
	"\t\traw: truncateTrailerEvidence(text),\n"
	"\t};\n"
	'\tconst detail = "details" in err ? summarizeTrailerDetails(err.details) : undefined;\n'
	"\tif (detail) {\n"
	"\t\ttrailer.detail = detail;\n"
	"\t\ttrailer.formatted += ` [details: ${detail}]`;\n"
	"\t}\n"
	"\treturn trailer;\n"
	"}\n"
	"\n"
	"/** Upper bound on retained raw-trailer evidence so log entries stay bounded. */\n"
	"const MAX_TRAILER_EVIDENCE_CHARS = 2000;\n"
	"\n"
	"function truncateTrailerEvidence(text: string): string {\n"
	"\treturn text.length > MAX_TRAILER_EVIDENCE_CHARS ? `${text.slice(0, MAX_TRAILER_EVIDENCE_CHARS)}\u2026` : text;\n"
	"}\n"
	"\n"
	"/**\n"
	" * Summarize Connect error `details` entries (loosely `{ type, value, debug }`\n"
	" * records). #4218's intermittent `invalid_argument` rejections arrive as\n"
	" * end-of-stream trailers with no HTTP error body, so any detail payload here\n"
	" * is the only server-side evidence available; previously it was discarded.\n"
	" */\n"
	"function summarizeTrailerDetails(details: unknown): string | undefined {\n"
	"\tif (!Array.isArray(details) || details.length === 0) return undefined;\n"
	"\tconst parts: string[] = [];\n"
	"\tfor (const entry of details) {\n"
	'\t\tif (!entry || typeof entry !== "object") continue;\n'
	"\t\tconst record = entry as Record<string, unknown>;\n"
	'\t\tconst type = typeof record.type === "string" && record.type ? record.type : undefined;\n'
	"\t\tlet debug: string | undefined;\n"
	"\t\tif (record.debug !== undefined) {\n"
	"\t\t\ttry {\n"
	'\t\t\t\tdebug = typeof record.debug === "string" ? record.debug : JSON.stringify(record.debug);\n'
	"\t\t\t} catch {\n"
	"\t\t\t\tdebug = undefined;\n"
	"\t\t\t}\n"
	"\t\t}\n"
	"\t\tif (type && debug) parts.push(`${type}: ${debug}`);\n"
	"\t\telse if (type) parts.push(type);\n"
	"\t\telse if (debug) parts.push(debug);\n"
	"\t}\n"
	"\tif (parts.length === 0) return undefined;\n"
	'\treturn parts.join("; ");\n'
	"}\n"
)

patch(
	"packages/ai/src/providers/devin.ts",
	[
		(
			"\t\t\t\t\t\tif (trailerError) {\n"
			"\t\t\t\t\t\t\tconst error = new AIError.ValidationError(trailerError.formatted);\n",
			EVIDENCE_LOG,
		),
		(
			"interface ConnectTrailerError {\n"
			"\tcode: string;\n"
			"\tmessage: string;\n"
			"\tformatted: string;\n"
			"}\n",
			NEW_INTERFACE,
		),
		(
			"\tif (!code && !message) return null;\n"
			"\treturn {\n"
			"\t\tcode,\n"
			"\t\tmessage,\n"
			"\t\tformatted: `Devin stream error${code ? ` ${code}` : \"\"}: ${message}`,\n"
			"\t};\n"
			"}\n",
			NEW_TAIL,
		),
	],
)

print("all patches applied")
