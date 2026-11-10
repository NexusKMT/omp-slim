import type { Tool } from "@oh-my-pi/pi-ai";

/**
 * Render `name(key=value, …)` with Python-literal argument values. Top-level
 * multiline strings render as verbatim `"""…"""` blocks so payload-carrying
 * args (file content, scripts, patches) keep real newlines instead of `\n`
 * escape soup; nested values always use escaped single-line literals.
 */
export function pyCall(name: string, args: Record<string, unknown>): string {
	let kwargs = "";
	for (const key in args) {
		kwargs += `${kwargs ? ", " : ""}${key}=${pyArgValue(args[key])}`;
	}
	return `${name}(${kwargs})`;
}

function pyArgValue(value: unknown): string {
	if (typeof value === "string" && value.includes("\n")) {
		// Verbatim `"""` fencing is only unambiguous when the content cannot
		// collide with the fence: no `"""` inside, no quote butting against a
		// fence edge, no trailing backslash swallowing the closer.
		const fenceSafe =
			!value.includes('"""') && !value.startsWith('"') && !value.endsWith('"') && !value.endsWith("\\");
		if (fenceSafe) return `"""${value}"""`;
	}
	return pyValue(value);
}

/** Render a JSON-ish value as a Python literal (`True`/`False`/`None`, escaped strings, lists, dicts). */
export function pyValue(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : pyString(String(value));
	if (typeof value === "string") return pyString(value);
	if (Array.isArray(value)) return `[${value.map(pyValue).join(", ")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		let entries = "";
		for (const key in record) {
			entries += `${entries ? ", " : ""}${pyString(key)}: ${pyValue(record[key])}`;
		}
		return `{${entries}}`;
	}
	return pyString(String(value));
}

function pyString(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
	return `"${escaped}"`;
}

const INTENT_PLACEHOLDER = "…";

/**
 * Render a tool's examples as an `<examples>` block. Calls render in Python
 * keyword-argument syntax (`name(key="value", n=1)`) regardless of the model's
 * tool-call dialect, so example bytes stay identical across models. Multiline
 * string args render as verbatim `"""…"""` blocks, and a call whose only
 * argument is a string renders as the bare value — the block already names the
 * tool, and payload args (commands, code, patches) read best verbatim.
 */
export function renderToolExamples(tool: Pick<Tool, "name" | "examples">, intentField?: string): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const renderCall = (args: Record<string, unknown>): string => {
		const bare = bareStringArg(args);
		if (bare !== undefined) {
			// Bare payload. The intent placeholder still rides on the envelope so
			// intent-traced schemas (where `i` is required) keep teaching it.
			const intentAttr = intentField ? ` ${intentField}="${INTENT_PLACEHOLDER}"` : "";
			return `<example${intentAttr}>\n${bare}\n</example>`;
		}
		// When intent tracing injects `i` into the schema, examples must show a
		// placeholder so the model learns to emit it. Keep it first, matching the
		// schema injection order.
		const finalArgs = intentField ? { [intentField]: INTENT_PLACEHOLDER, ...args } : args;
		return `<example>\n${pyCall(tool.name, finalArgs)}\n</example>`;
	};
	const parts = examples.map(ex => {
		const head = ex.caption ? `# ${ex.caption}\n` : "";
		if ("call" in ex) return head + renderCall(ex.call);
		if ("good" in ex) {
			return `${head}WRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		}
		return head.trimEnd() + (ex.note ? `\n${ex.note}` : "");
	});
	return `<examples>\n${parts.join("\n")}\n</examples>`;
}

/** Sole-argument string payload, if the call has exactly one string argument. */
function bareStringArg(args: Record<string, unknown>): string | undefined {
	let sole: unknown;
	let count = 0;
	for (const key in args) {
		count++;
		sole = args[key];
	}
	return count === 1 && typeof sole === "string" ? sole : undefined;
}
