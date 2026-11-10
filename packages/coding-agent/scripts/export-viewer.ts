import * as path from "node:path";
import type { ExportViewerMetadata } from "../../collab-web/scripts/build-export-viewer";

const packageDir = path.join(import.meta.dir, "..");

/** Read the generated viewer after generation, including metadata updated by a local build. */
export async function readExportViewer(): Promise<string> {
	const metadata: ExportViewerMetadata = await Bun.file(
		path.join(packageDir, "src/export/html/viewer.generated.json"),
	).json();
	const viewer = await Bun.file(path.join(packageDir, "export-assets", metadata.file)).text();
	const bytes = Buffer.from(viewer);
	if (bytes.length !== metadata.size || `sha256-${Bun.SHA256.hash(bytes, "base64")}` !== metadata.integrity) {
		throw new Error("Export viewer asset does not match its metadata. Run bun gen:export-viewer.");
	}
	return viewer;
}
