#!/usr/bin/env python3
"""One-off patcher for #4813, applied by a temporary workflow and then removed.

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


patch(
	"packages/ai/src/providers/cursor.ts",
	[
		(
			'import { toolWireSchema } from "../utils/schema/wire";\n',
			'import { toolWireSchema } from "../utils/schema/wire";\n'
			'import { formatConnectEndStreamError } from "./connect-error-detail";\n',
		),
		(
			'\t\t\tconst code = typeof error.code === "string" ? error.code : "unknown";\n'
			'\t\t\tconst message = typeof error.message === "string" ? error.message : "Unknown error";\n'
			"\t\t\treturn new AIError.ProviderResponseError(`Connect error ${code}: ${message}`, { kind: \"envelope\" });\n",
			'\t\t\treturn new AIError.ProviderResponseError(formatConnectEndStreamError(error), { kind: "envelope" });\n',
		),
	],
)

patch(
	"packages/coding-agent/src/task/executor.ts",
	[
		(
			'import { generateTaskLabel } from "./label";\n',
			'import { attributeSubagentError } from "./error-attribution";\n'
			'import { generateTaskLabel } from "./label";\n',
		),
		(
			'\t\t\t\terror ??= lastAssistant.errorMessage || "Subagent failed";\n',
			"\t\t\t\terror ??= attributeSubagentError(lastAssistant.errorMessage, lastAssistant);\n",
		),
		(
			'\t\t\t\t\t? lastAssistant.errorMessage || "Subagent failed"\n',
			"\t\t\t\t\t? attributeSubagentError(lastAssistant.errorMessage, lastAssistant)\n",
		),
	],
)

print("all patches applied")
