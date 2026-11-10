import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";
import { __ompSetGrammarDir, wasmGrammarFor } from "@oh-my-pi/pi-natives";

const filePath = process.argv[2];
if (!filePath) throw new Error("Expected a TLA+ or PlusCal source file");
const operation = process.argv[3];
if (operation !== "grep" && operation !== "edit") throw new Error("Expected grep or edit");
const cwd = path.dirname(filePath);
const grammarDir = path.join(cwd, "grammars");
__ompSetGrammarDir(grammarDir);

const info = wasmGrammarFor({ lang: "tlaplus" });
if (!info) throw new Error("TLA+ must use a wasm grammar");
const compressed = await Bun.file(path.join(import.meta.dir, "grammars", `${info.file}.zst`)).bytes();
const wasm = Bun.zstdDecompressSync(compressed);
const digest = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
if (wasm.byteLength !== info.size || digest !== info.sha256) {
	throw new Error("TLA+ fixture does not match the native grammar manifest");
}
await Bun.write(path.join(grammarDir, info.file), wasm);

const queue = new ToolChoiceQueue();
const tools = await createTools(
	{
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "astGrep.enabled": true, "tools.xdev": false }),
		getToolChoiceQueue: () => queue,
		buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
		steer: () => {},
	},
	[`ast_${operation}`],
);
const tool = tools.find(entry => entry.name === `ast_${operation}`);
if (!tool) throw new Error(`ast_${operation} tool is unavailable`);
if (operation === "grep") {
	const matches: Record<string, number | undefined> = {};
	for (const lang of ["tlaplus", "pluscal", "pcal"]) {
		const result = await tool.execute(`ast-grep-${lang}`, { pat: "x", path: filePath, lang });
		matches[lang] = (result.details as { matchCount?: number } | undefined)?.matchCount;
	}
	process.stdout.write(JSON.stringify(matches));
} else {
	const result = await tool.execute("ast-edit-tlaplus", {
		ops: [{ pat: "Init", out: "Start" }],
		paths: [filePath],
	});
	const invoker = queue.peekPendingInvoker();
	if (!invoker) throw new Error("TLA+ edit must queue an apply action");
	await invoker({ action: "apply", reason: "apply tlaplus AST edit" });
	process.stdout.write(JSON.stringify(result));
}
