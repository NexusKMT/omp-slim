import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	workspaceRootForPath,
} from "@oh-my-pi/pi-coding-agent/session/session-workspace";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("normalizeSessionWorkspace", () => {
	it("places cwd first and dedupes additional directories", () => {
		const cwd = "/home/user/proj";
		const workspace = normalizeSessionWorkspace({ cwd, directories: ["/home/user/other", cwd, "/home/user/other"] });
		expect(workspace.cwd).toBe(path.resolve(cwd));
		expect(workspace.directories).toEqual([path.resolve(cwd), path.resolve("/home/user/other")]);
	});

	it("resolves relative additional directories against the normalized cwd", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/home/user/proj", directories: ["../sibling"] });
		expect(workspace.directories).toEqual([path.resolve("/home/user/proj"), path.resolve("/home/user/sibling")]);
	});

	it("expands ~ to home", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/tmp", directories: ["~/docs"] });
		expect(workspace.directories[1]).toBe(path.join(process.env.HOME ?? require("node:os").homedir(), "docs"));
	});
});

describe("additionalWorkspaceDirectories", () => {
	it("returns every directory except cwd", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/a", directories: ["/b", "/c"] });
		expect(additionalWorkspaceDirectories(workspace)).toEqual([path.resolve("/b"), path.resolve("/c")]);
	});

	it("is empty for a single-root workspace", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/a" });
		expect(additionalWorkspaceDirectories(workspace)).toEqual([]);
	});
});

describe("workspaceRootForPath", () => {
	it("picks the longest-prefix match", () => {
		const dirs = ["/repo", "/repo/packages/sub"];
		expect(workspaceRootForPath("/repo/packages/sub/file.ts", dirs, "/fallback")).toBe("/repo/packages/sub");
		expect(workspaceRootForPath("/repo/other/file.ts", dirs, "/fallback")).toBe("/repo");
	});

	it("falls back when no root contains the path", () => {
		expect(workspaceRootForPath("/elsewhere/file.ts", ["/repo"], "/fallback")).toBe("/fallback");
	});
});

describe("SessionManager workspace directories", () => {
	it("starts with no additional directories", () => {
		const session = SessionManager.inMemory();
		expect(session.getAdditionalDirectories()).toEqual([]);
		expect(session.getWorkspace().directories).toEqual([session.getCwd()]);
	});

	it("seeds from setAdditionalDirectories and excludes cwd", () => {
		const session = SessionManager.inMemory();
		session.setAdditionalDirectories(["/some/other", session.getCwd()]);
		// cwd is filtered out of the additional set.
		expect(session.getAdditionalDirectories()).toEqual(["/some/other"]);
		expect(session.getWorkspace().directories).toEqual([session.getCwd(), "/some/other"]);
	});

	it("addWorkspaceDirectory rejects the cwd itself", async () => {
		const session = SessionManager.inMemory();
		await expect(session.addWorkspaceDirectory(session.getCwd())).rejects.toThrow(/primary workspace root/);
	});

	it("addWorkspaceDirectory returns the resolved path and dedupes on repeat", async () => {
		const session = SessionManager.inMemory();
		const added = await session.addWorkspaceDirectory("/another/repo");
		expect(added).toBe(path.resolve("/another/repo"));
		expect(session.getAdditionalDirectories()).toEqual([path.resolve("/another/repo")]);

		// Second add of the same path is a no-op.
		const second = await session.addWorkspaceDirectory("/another/repo");
		expect(second).toBeNull();
		expect(session.getAdditionalDirectories()).toEqual([path.resolve("/another/repo")]);
	});

	it("removeWorkspaceDirectory removes a known root and returns null when absent", async () => {
		const session = SessionManager.inMemory();
		await session.addWorkspaceDirectory("/x");
		const removed = await session.removeWorkspaceDirectory("/x");
		expect(removed).toBe(path.resolve("/x"));
		expect(session.getAdditionalDirectories()).toEqual([]);

		const again = await session.removeWorkspaceDirectory("/x");
		expect(again).toBeNull();
	});

	it("persists additionalDirectories in the session header across reopen", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-persist-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.addWorkspaceDirectory(path.join(tempDir.path(), "sibling"));
		// Materialize on disk so reopen reads the header.
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const reopened = await SessionManager.open(file!);
		expect(reopened.getAdditionalDirectories()).toEqual([path.join(tempDir.path(), "sibling")]);
		expect(reopened.getWorkspace().directories).toEqual([tempDir.path(), path.join(tempDir.path(), "sibling")]);
	});

	it("clears the header field when the last additional directory is removed", async () => {
		using tempDir = TempDir.createSync("@pi-session-workspace-clear-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.addWorkspaceDirectory(path.join(tempDir.path(), "extra"));
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		await session.flush();

		await session.removeWorkspaceDirectory(path.join(tempDir.path(), "extra"));
		const file = session.getSessionFile()!;
		const raw = fs.readFileSync(file, "utf8").split("\n")[0]!;
		const header = JSON.parse(raw);
		expect(header.additionalDirectories).toBeUndefined();
	});
});
