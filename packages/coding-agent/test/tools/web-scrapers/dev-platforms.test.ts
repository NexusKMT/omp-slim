import { describe, expect, it } from "bun:test";
import { handleGitLab } from "@oh-my-pi/pi-coding-agent/web/scrapers/gitlab";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

// =============================================================================
// GitLab Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitLab", () => {
	it("returns null for non-GitLab URLs", async () => {
		const result = await handleGitLab("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("fetches repository root", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-repo");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Stars:");
		expect(result?.content).toContain("Forks:");
	});

	it("fetches file blob", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-raw");
		expect(result?.contentType).toBe("text/plain");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches directory tree", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/tree/master", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-tree");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Directory:");
	});

	it("fetches issue", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/issues/1", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-issue");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Issue #1:");
		expect(result?.content).toContain("State:");
	});

	it("fetches merge request", async () => {
		const result = await handleGitLab("https://gitlab.com/gitlab-org/gitlab/-/merge_requests/1", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("gitlab-mr");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("MR !1:");
		expect(result?.content).toContain("State:");
	});

	it("returns null for invalid URL structure", async () => {
		const result = await handleGitLab("https://gitlab.com/", 10000);
		expect(result).toBeNull();
	});

	it("returns null for malformed paths", async () => {
		const result = await handleGitLab("https://gitlab.com/user", 10000);
		expect(result).toBeNull();
	});
});
