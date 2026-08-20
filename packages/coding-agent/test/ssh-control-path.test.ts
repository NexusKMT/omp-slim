import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	controlDirGuardError,
	controlPathFitsBudget,
	getControlDir,
	getControlPathTemplate,
	resolveSshControlDir,
	sshControlFallbackDir,
} from "../src/ssh/connection-manager";

// Regression coverage for #9070: named-profile roots pushed the SSH ControlPath
// past macOS's 104-byte sun_path once OpenSSH appends its mux temp suffix.
describe("SSH control-path budget (#9070)", () => {
	it("rejects a control dir that overflows sun_path once %C.sock + mux temp bind is added", () => {
		// A representative macOS named-profile control dir is 48 bytes; the
		// temporary bind path is 48 + 63 = 111 >= 104, so it must not fit.
		const profileDir = "/Users/arthur/.omp/profiles/upstream/ssh-control";
		expect(Buffer.byteLength(profileDir)).toBe(48);
		expect(controlPathFitsBudget(profileDir, "darwin")).toBe(false);
		// The default (unprofiled) macOS dir stays within budget.
		expect(controlPathFitsBudget("/Users/arthur/.omp/ssh-control", "darwin")).toBe(true);
	});

	it("places the darwin boundary at 40 bytes of control dir", () => {
		expect(controlPathFitsBudget("a".repeat(40), "darwin")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(41), "darwin")).toBe(false);
	});

	it("routes on platform: 42-byte dir fits Linux's 108 but not macOS's 104", () => {
		const dir = "a".repeat(42);
		expect(controlPathFitsBudget(dir, "darwin")).toBe(false);
		expect(controlPathFitsBudget(dir, "linux")).toBe(true);
		// Linux boundary sits at 44 bytes.
		expect(controlPathFitsBudget("a".repeat(44), "linux")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(45), "linux")).toBe(false);
	});
});

describe("sshControlFallbackDir", () => {
	it("is deterministic and leaves 11 bytes of macOS sun_path slack", () => {
		const root = "/Users/arthur/.omp/profiles/upstream";
		const a = sshControlFallbackDir(root, 501);
		const b = sshControlFallbackDir(root, 501);
		expect(a).toBe(b);
		expect(a).toBe("/tmp/omp-eab7c36f6b3b52ea9bb3");
		expect(Buffer.byteLength(a)).toBe(29);
		const tempBind = path.join(a, `${"a".repeat(40)}.sock.${"b".repeat(16)}`);
		expect(Buffer.byteLength(tempBind)).toBe(92);
		expect(103 - Buffer.byteLength(tempBind)).toBe(11);
		expect(controlPathFitsBudget(a, "darwin")).toBe(true);
	});

	it("isolates distinct config roots and uids", () => {
		const base = "/Users/arthur/.omp";
		expect(sshControlFallbackDir(base, 501)).not.toBe(sshControlFallbackDir(`${base}/profiles/x`, 501));
		expect(sshControlFallbackDir(base, 501)).not.toBe(sshControlFallbackDir(base, 502));
	});
});

describe("resolveSshControlDir", () => {
	const configRoot = "/Users/arthur/.omp/profiles/upstream";

	it("keeps the canonical dir when it fits", () => {
		const canonicalDir = "/Users/arthur/.omp/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, configRoot, platform: "darwin", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});

	it("relocates to the bounded shared fallback when the canonical dir overflows", () => {
		const canonicalDir = `${configRoot}/ssh-control`;
		const choice = resolveSshControlDir({ canonicalDir, configRoot, platform: "darwin", uid: 501, tmpBase: "/tmp" });
		expect(choice).toEqual({ dir: "/tmp/omp-eab7c36f6b3b52ea9bb3", shared: true });
		expect(controlPathFitsBudget(choice.dir, "darwin")).toBe(true);
	});

	it("never relocates on Windows (ControlMaster unused) even for a long path", () => {
		const canonicalDir = `${configRoot}/ssh-control`;
		expect(resolveSshControlDir({ canonicalDir, configRoot, platform: "win32", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});

	it("keeps the canonical dir when there is no uid to key the fallback", () => {
		const canonicalDir = `${configRoot}/ssh-control`;
		expect(resolveSshControlDir({ canonicalDir, configRoot, platform: "darwin", uid: undefined })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});
});

describe("controlDirGuardError", () => {
	const ok = { isSymlink: false, isDir: true, uid: 501, mode: 0o700 };

	it("accepts an owner-private directory", () => {
		expect(controlDirGuardError(ok, 501)).toBeNull();
	});

	it("rejects a symlink, non-directory, foreign owner, and loose mode", () => {
		expect(controlDirGuardError({ ...ok, isSymlink: true }, 501)).toBe("is a symlink");
		expect(controlDirGuardError({ ...ok, isDir: false }, 501)).toBe("is not a directory");
		expect(controlDirGuardError({ ...ok, uid: 999 }, 501)).toContain("not 501");
		expect(controlDirGuardError({ ...ok, mode: 0o755 }, 501)).toContain("0700");
	});

	it("skips the owner check when the process has no uid", () => {
		expect(controlDirGuardError({ ...ok, uid: 999 }, undefined)).toBeNull();
	});
});

describe("control template sharing", () => {
	// sshfs-mount consumes getControlPathTemplate()/getControlDir() verbatim, so
	// the %C.sock basename and its parent dir must stay in lockstep.
	it("keeps %C.sock under the resolved control dir", () => {
		expect(getControlPathTemplate()).toBe(path.join(getControlDir(), "%C.sock"));
	});
});
