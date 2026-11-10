import { afterEach, describe, expect, it, vi } from "bun:test";
import * as piNatives from "@oh-my-pi/pi-natives";
import { PdfConverter } from "../src/markit/converters/pdf";

describe("PdfConverter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps accepting PDF extensions and MIME types", () => {
		const converter = new PdfConverter();

		expect(converter.accepts({ extension: ".pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf; charset=binary" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/x-pdf" })).toBe(true);
		expect(converter.accepts({ extension: ".txt", mimetype: "text/plain" })).toBe(false);
	});

	it("explains that pages without extractable text require external OCR", async () => {
		vi.spyOn(piNatives, "pdfToMarkdown").mockResolvedValue({
			markdown: "",
			pageCount: 3,
			pagesNeedingOcr: [2, 3],
			hasEncodingIssues: false,
		});

		const result = await new PdfConverter().convert(Buffer.from("image-only pdf"), { extension: ".pdf" });

		expect(result.markdown).toBe(
			"Text extraction is incomplete for PDF pages 2, 3. OCR is required to read image-only pages; run an external OCR tool and read the resulting text file.",
		);
		expect(result.markdown.length).toBeGreaterThan(0);
	});
});
