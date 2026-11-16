import { describe, expect, it } from "bun:test";
import { isFullyQualifiedPath, windowsPathToWslMount } from "../src/path";

describe("windowsPathToWslMount", () => {
	it("clamps parent traversal at the Windows drive root", () => {
		expect(windowsPathToWslMount("C:\\..\\Windows\\x")).toBe("/mnt/c/Windows/x");
	});

	it("rejects paths without an absolute Windows drive", () => {
		expect(windowsPathToWslMount("/home/me/file.txt")).toBeUndefined();
	});
});

describe("isFullyQualifiedPath", () => {
	it("identifies absolute POSIX paths", () => {
		expect(isFullyQualifiedPath("/usr/local/bin/omp")).toBe(true);
		expect(isFullyQualifiedPath("/bin/omp")).toBe(true);
		expect(isFullyQualifiedPath("./omp")).toBe(false);
		expect(isFullyQualifiedPath("omp")).toBe(false);
		expect(isFullyQualifiedPath("C:\\omp\\bin\\omp.exe")).toBe(false);
	});
});
