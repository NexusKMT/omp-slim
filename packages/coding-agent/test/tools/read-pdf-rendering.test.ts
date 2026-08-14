import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, type ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false }),
	} as ToolSession;
}

function textOf(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text)
		.join("\n");
}

describe("read unsupported PDF image members", () => {
	let testDir: string;
	let pdfPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-image-unsupported-"));
		pdfPath = path.join(testDir, "doc.pdf");
		await fs.writeFile(pdfPath, `%PDF-stub-${testDir}`);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("directs former image listing and PNG member reads to browser rendering", async () => {
		const tool = new ReadTool(makeSession(testDir));

		for (const readPath of [`${pdfPath}:`, `${pdfPath}:p1-img0.png`]) {
			try {
				await tool.execute("read-pdf-image", { path: readPath });
				throw new Error("Expected the PDF image read to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain("pdf-inspector cannot render PDF images");
				expect(message).toContain("Puppeteer browser tool");
				expect(message).toContain(`read '${pdfPath}' for extracted text`);
			}
		}
	});

	it("preserves a literal filename that looks like a PDF image listing", async () => {
		const literalPath = `${pdfPath}:`;
		await fs.writeFile(literalPath, "literal colon path wins\n");

		const result = await new ReadTool(makeSession(testDir)).execute("read-literal", { path: literalPath });
		expect(textOf(result)).toContain("literal colon path wins");
	});

	it("routes PDF line selectors through normal document conversion", async () => {
		const convert = vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({
			ok: true,
			content: "first line\nselected line\nthird line\n",
		});

		const result = await new ReadTool(makeSession(testDir)).execute("read-pdf-lines", { path: `${pdfPath}:2-2` });
		expect(convert).toHaveBeenCalledTimes(1);
		expect(textOf(result)).toContain("selected line");
	});
});
