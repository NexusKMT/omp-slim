import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBrowserRelayCommand } from "../src/cli/browser-relay-cli";

const repoRoot = path.resolve(import.meta.dir, "../../..");

it("installs the browser extension with its exact legal payload", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-extension-"));
	const dir = path.join(root, "extension");
	const logSpy = spyOn(console, "log").mockImplementation(() => {});
	try {
		await runBrowserRelayCommand({ action: "install", port: 9224, dir });
		expect((await fs.readdir(dir)).sort()).toEqual([
			"LICENSE",
			"THIRD-PARTY-NOTICES.txt",
			"background.js",
			"manifest.json",
			"options.html",
			"options.js",
		]);
		expect(await Bun.file(path.join(dir, "LICENSE")).text()).toBe(
			await Bun.file(path.join(repoRoot, "LICENSE")).text(),
		);
		expect(await Bun.file(path.join(dir, "THIRD-PARTY-NOTICES.txt")).text()).toBe(
			await Bun.file(path.join(repoRoot, "THIRD-PARTY-NOTICES.txt")).text(),
		);
	} finally {
		logSpy.mockRestore();
		await fs.rm(root, { recursive: true, force: true });
	}
});
