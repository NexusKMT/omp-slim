import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __ompSetGrammarDir, parseCodeStatus, summarizeCode, wasmGrammarFor } from "../../native";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parse-status-"));
try {
	__ompSetGrammarDir(directory);
	const options = { code: "[core]\nname = pi\n", lang: "ini" };
	const grammar = wasmGrammarFor({ lang: options.lang });
	if (!grammar) throw new Error("INI must use a wasm grammar");
	const missing = parseCodeStatus(options);
	await Bun.write(path.join(directory, grammar.file), "invalid wasm module");
	if (grammar.enabled === false) {
		const cached = parseCodeStatus(options);
		const summary = summarizeCode(options);
		if (cached.parsed || summary.parsed || wasmGrammarFor(options)?.installed) {
			throw new Error("Disabled grammars must stay unsupported even when cached files exist");
		}
		process.stdout.write(
			JSON.stringify({
				enabled: false,
				missing: { parsed: missing.parsed, language: missing.language ?? null },
				cached: { parsed: cached.parsed, language: cached.language ?? null },
			}),
		);
	} else {
		let statusError: string | undefined;
		let summaryError: string | undefined;
		try {
			parseCodeStatus(options);
		} catch (error) {
			statusError = error instanceof Error ? error.message : String(error);
		}
		try {
			summarizeCode(options);
		} catch (error) {
			summaryError = error instanceof Error ? error.message : String(error);
		}
		if (!statusError || !summaryError) throw new Error("Corrupt grammar must surface an error");
		process.stdout.write(
			JSON.stringify({
				enabled: true,
				missing: { parsed: missing.parsed, language: missing.language ?? null },
				statusError,
				summaryError,
			}),
		);
	}
} finally {
	await fs.rm(directory, { recursive: true, force: true });
}
