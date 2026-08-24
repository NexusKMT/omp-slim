import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("rejects a short write instead of publishing an unreadable artifact id", async () => {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		const manager = new ArtifactManager(dir);
		vi.spyOn(Bun, "write").mockResolvedValue(1);

		await expect(manager.save("complete report", "task")).rejects.toThrow(
			"Artifact write incomplete: wrote 1 of 15 bytes",
		);
	});
});
