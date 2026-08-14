const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;

/** Parse a former PDF image-member read without claiming normal selectors. */
export function splitUnsupportedPdfImageReadPath(readPath: string): { pdfPath: string } | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	const pdfPath = match?.[1];
	return pdfPath ? { pdfPath } : null;
}

/** Explain how to render a PDF now that the text backend has no rasterizer. */
export function pdfImageRenderingUnsupportedMessage(pdfPath: string): string {
	return `pdf-inspector cannot render PDF images. Use the Puppeteer browser tool to render '${pdfPath}', or read '${pdfPath}' for extracted text.`;
}
