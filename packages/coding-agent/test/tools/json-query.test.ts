import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ReadTool } from "../../src/tools/read";
import { parseJsonPathCandidates, parseJsonSelector } from "../../src/tools/read-json";

type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
};

type SessionLike = ConstructorParameters<typeof ReadTool>[0];

function getText(result: ToolTextResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<SessionLike> = {}): SessionLike {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as SessionLike;
}

describe("JSON query in read tool", () => {
	let tempDir: string;
	let jsonFile: string;
	let jsonlFile: string;
	let session: SessionLike;
	let readTool: ReadTool;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-test-"));
		jsonFile = path.join(tempDir, "data.json");
		jsonlFile = path.join(tempDir, "events.jsonl");

		const testData = {
			name: "my-project",
			version: "1.2.3",
			active: true,
			items: [
				{ id: 1, name: "item-one", active: true },
				{ id: 2, name: "item-two", active: false },
				{ id: 3, name: "item-three", active: true },
			],
			metadata: {
				tags: ["alpha", "beta", "gamma"],
				nested: { deep: "secret-value" },
			},
		};

		const testLines = [
			JSON.stringify({ timestamp: "2026-10-01", status: "ok", user: "alice" }),
			JSON.stringify({ timestamp: "2026-10-02", status: "error", user: "bob" }),
			JSON.stringify({ timestamp: "2026-10-03", status: "ok", user: "charlie" }),
		];

		await fs.writeFile(jsonFile, JSON.stringify(testData, null, 2), "utf-8");
		await fs.writeFile(jsonlFile, testLines.join("\n") + "\n", "utf-8");

		session = createSession(tempDir);
		readTool = new ReadTool(session);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("parses candidate paths with query parameters", () => {
		const candidates = parseJsonPathCandidates("src/package.json?q=.name");
		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates[0].jsonPath).toBe("src/package.json");
		expect(candidates[0].queryString).toBe("q=.name");
	});

	it("parses selector parameters correctly", () => {
		const selector = parseJsonSelector("", "q=.items[] | .id&raw=true&compact=true");
		expect(selector).not.toBeNull();
		expect(selector?.kind).toBe("query");
		expect(selector?.query).toBe(".items[] | .id");
		expect(selector?.raw).toBe(true);
		expect(selector?.compact).toBe(true);
	});

	it("returns null selector when no q or query parameter is present", () => {
		const selector = parseJsonSelector("", "limit=20");
		expect(selector).toBeNull();
	});
	it("queries a simple property from a JSON file", async () => {
		const result = await readTool.execute("call_1", { path: `${jsonFile}?q=.name` });
		const text = getText(result);
		expect(text).toContain('"my-project"');
	});

	it("queries with pipes in jq filter expression", async () => {
		const result = await readTool.execute("call_2", { path: `${jsonFile}?q=.items[] | select(.active) | .name` });
		const text = getText(result);
		expect(text).toContain('"item-one"');
		expect(text).toContain('"item-three"');
		expect(text).not.toContain('"item-two"');
	});

	it("supports raw unquoted output and preserves trailing whitespace", async () => {
		const result = await readTool.execute("call_3", { path: `${jsonFile}?q="foo  "&raw=true` });
		const text = getText(result);
		expect(text).toBe("foo  ");
	});

	it("supports compact output via compact=true parameter", async () => {
		const result = await readTool.execute("call_4", { path: `${jsonFile}?q=.metadata.tags&compact=true` });
		const text = getText(result);
		expect(text.trim()).toBe('["alpha","beta","gamma"]');
	});

	it("queries JSONL stream lines with filtering", async () => {
		const result = await readTool.execute("call_5", {
			path: `${jsonlFile}?q=select(.status == "ok") | .user&raw=true`,
		});
		const text = getText(result);
		const lines = text.trim().split("\n");
		expect(lines).toEqual(["alice", "charlie"]);
	});

	it("fails cleanly with descriptive error on invalid jq syntax", async () => {
		await expect(readTool.execute("call_6", { path: `${jsonFile}?q=invalid [[[` })).rejects.toThrow(
			/Failed to execute JSON query/i,
		);
	});

	it("reads the file normally without jq query when ?q= is omitted", async () => {
		const result = await readTool.execute("call_7", { path: jsonFile });
		const text = getText(result);
		expect(text).toContain('"my-project"');
		expect(text).toContain('"secret-value"');
	});

	it("supports offset and limit pagination on JSON arrays with repeatable continuation hint", async () => {
		const result = await readTool.execute("call_p1", { path: `${jsonFile}?q=.items&offset=1&limit=1` });
		const text = getText(result);
		expect(text).toContain('"item-two"');
		expect(text).not.toContain('"item-one"');
		expect(text).not.toContain('"item-three"');
		expect(text).toContain("[1 more items; append ?q=.items&limit=1&offset=2 to continue]");

		// Follow the continuation hint
		const nextResult = await readTool.execute("call_p1_cont", { path: `${jsonFile}?q=.items&limit=1&offset=2` });
		const nextText = getText(nextResult);
		expect(nextText).toContain('"item-three"');
		expect(nextText).not.toContain('"item-two"');
	});

	it("preserves compact format when paging an array with compact=true", async () => {
		const result = await readTool.execute("call_compact_page", {
			path: `${jsonFile}?q=.items&compact=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain('[{"id":2,"name":"item-two","active":false}]');
	});

	it("does not slice a single JSON object mid-syntax when limit is supplied", async () => {
		const result = await readTool.execute("call_obj_limit", {
			path: `${jsonFile}?q=.metadata&limit=2`,
		});
		const text = getText(result);
		expect(text).toContain('"tags"');
		expect(text).toContain('"nested"');
		expect(text).toContain('"secret-value"');
		expect(() => JSON.parse(text)).not.toThrow();
	});

	it("preserves arithmetic + operator in jq filters without URL corruption", async () => {
		const result = await readTool.execute("call_plus", {
			path: `${jsonFile}?q=.items | length + 1`,
		});
		const text = getText(result);
		expect(text.trim()).toBe("4");
	});

	it("supports offset and limit pagination on JSONL streams with continuation hint", async () => {
		const result = await readTool.execute("call_p2", {
			path: `${jsonlFile}?q=.user&raw=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain("bob");
		expect(text).not.toContain("alice");
		expect(text).not.toContain("charlie");
		expect(text).toContain("[1 more items; append ?q=.user&raw=true&limit=1&offset=2 to continue]");
	});

	it("applies trailing line range selectors over query output", async () => {
		const result = await readTool.execute("call_sel", {
			path: `${jsonFile}?q=.items[] | .name&raw=true:raw:1-2`,
		});
		const text = getText(result);
		expect(text).toContain("item-one");
		expect(text).toContain("item-two");
		expect(text).not.toContain("item-three");
	});
});
