import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 1x1 PNG attached to image-bearing skill prompts. */
export const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/**
 * Resolve once `file` exists, driven by change events on its directory rather than a polling timer.
 * Cross-process handshake that also works on Windows, where signals like SIGUSR1 do not exist.
 */
export async function waitForFile(file: string): Promise<void> {
	const controller = new AbortController();
	const events = fs.watch(path.dirname(file), { signal: controller.signal });
	try {
		if (await Bun.file(file).exists()) return;
		for await (const _ of events) {
			if (await Bun.file(file).exists()) return;
		}
		throw new Error(`watch on ${path.dirname(file)} ended before ${path.basename(file)} was created`);
	} finally {
		controller.abort();
	}
}
