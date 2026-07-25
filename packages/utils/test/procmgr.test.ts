import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getShellConfig } from "../src/procmgr";

describe("getShellConfig", () => {
	it("directs invalid custom shell paths to the canonical config file", () => {
		const missingShell = path.join(os.tmpdir(), `omp-missing-shell-${process.pid}`, "bash");
		expect(() => getShellConfig(missingShell)).toThrow(
			`Custom shell path not found: ${missingShell}\nPlease update shellPath in ~/.omp/agent/config.yml`,
		);
	});
});
