import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { splitMixedUrlPathList } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let cwd: string;
let session: ToolSession;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-mixed-list-"));
	await Bun.write(path.join(cwd, "Makefile"), "build:\n\techo make\n");
	await Bun.write(path.join(cwd, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(cwd, "a;b.md"), "literal semicolon file\n");
	session = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		enableLsp: false,
	};
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

async function readText(target: string): Promise<string> {
	const result = await new ReadTool(session).execute("r", { path: target });
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("read with a `;` list mixing URLs and local paths", () => {
	it("reads an extensionless file with a selector as a local path, not an MCP resource", async () => {
		const text = await readText("Makefile:1-1;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("build:");
		expect(text).toContain("export const a = 1;");
	});

	it("splits an internal URL followed by a local path", async () => {
		const text = await readText("omp://;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
		expect(text).not.toContain("Documentation file not found");
	});

	it("keeps a URL that contains `;` and a literal file named with `;` whole", async () => {
		const isUrl = (part: string) => part.startsWith("https://");
		expect(await splitMixedUrlPathList("https://example.test/x;v=1", cwd, isUrl)).toBeNull();
		expect(await splitMixedUrlPathList("a;b.md", cwd, isUrl)).toBeNull();
		expect(await splitMixedUrlPathList("https://example.test/x;a.ts:1-1", cwd, isUrl)).toEqual([
			"https://example.test/x",
			"a.ts:1-1",
		]);
	});
});
