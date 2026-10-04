import { describe, expect, it } from "bun:test";
import { execCommand } from "../src/exec/exec";

const HANG = ["-e", "setTimeout(() => {}, 30_000)"];

describe("execCommand", () => {
	it("reports a non-zero code when the timeout kills the process", async () => {
		const result = await execCommand(process.execPath, HANG, process.cwd(), { timeout: 50 });
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});

	it("reports a non-zero code when the signal aborts the process", async () => {
		const controller = new AbortController();
		const pending = execCommand(process.execPath, HANG, process.cwd(), { signal: controller.signal });
		controller.abort();
		const result = await pending;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});
});
