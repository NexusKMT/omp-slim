import { describe, expect, it } from "bun:test";
import { handleCratesIo } from "@oh-my-pi/pi-coding-agent/web/scrapers/crates-io";
import { handleNpm } from "@oh-my-pi/pi-coding-agent/web/scrapers/npm";
import { handlePyPI } from "@oh-my-pi/pi-coding-agent/web/scrapers/pypi";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handlePyPI", () => {
	it("returns null for non-PyPI URLs", async () => {
		const result = await handlePyPI("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid PyPI URLs", async () => {
		const result = await handlePyPI("https://pypi.org/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches requests package", async () => {
		const result = await handlePyPI("https://pypi.org/project/requests/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pypi");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("requests");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via PyPI JSON API");
	});

	it("extracts package name correctly", async () => {
		const result = await handlePyPI("https://pypi.org/project/requests/2.28.0/", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("requests");
	});

	it("handles www subdomain", async () => {
		const result = await handlePyPI("https://www.pypi.org/project/requests/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pypi");
	});
});

describe.skipIf(SKIP)("handleNpm", () => {
	it("returns null for non-npm URLs", async () => {
		const result = await handleNpm("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid npm URLs", async () => {
		const result = await handleNpm("https://www.npmjs.com/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches lodash package", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/lodash", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("npm");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("lodash");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via npm registry");
	});

	it("includes version info", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/express", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Latest:\*\*\s*\d+\.\d+\.\d+/);
	});

	it("includes download stats", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/express", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Weekly Downloads/);
	});

	it("handles npmjs.com without www", async () => {
		const result = await handleNpm("https://npmjs.com/package/lodash", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("npm");
	});
});

describe.skipIf(SKIP)("handleCratesIo", () => {
	it("returns null for non-crates.io URLs", async () => {
		const result = await handleCratesIo("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid crates.io URLs", async () => {
		const result = await handleCratesIo("https://crates.io/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches serde package", async () => {
		const result = await handleCratesIo("https://crates.io/crates/serde", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("crates.io");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("serde");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via crates.io API");
	});

	it("includes version info", async () => {
		const result = await handleCratesIo("https://crates.io/crates/tokio", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Latest:\*\*\s*\d+\.\d+\.\d+/);
	});

	it("includes download stats", async () => {
		const result = await handleCratesIo("https://crates.io/crates/tokio", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Downloads:\*\*/);
		expect(result?.content).toMatch(/total.*recent/);
	});

	it("handles www subdomain", async () => {
		const result = await handleCratesIo("https://www.crates.io/crates/serde", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("crates.io");
	});
});
