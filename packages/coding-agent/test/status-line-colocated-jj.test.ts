/**
 * #11071: a colocated jj-git checkout resolved to Git in `detect()`, so the
 * status line showed the git HEAD ("detached" in practice, or a stale git
 * branch) instead of the active jj bookmark/change id.
 *
 * `detect()` intentionally still resolves colocated directories to Git (git
 * automation is safe there). Presentation instead consults the independent
 * `vcs.jj()` discovery and prefers the jj label when both discoveries share
 * the same root — regardless of git HEAD state. A jj workspace at a
 * different root (nested git under an outer jj tree) keeps the git branch,
 * and ordinary git without jj keeps "detached".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsJjWorkspace, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

type GitStatus = { staged: number; unstaged: number; untracked: number };

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "colocated-jj test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const attachedHead: VcsHeadState = {
	kind: "ref",
	branch: "git-branch-name",
	refName: "refs/heads/git-branch-name",
	commit: undefined,
};
const detachedHead: VcsHeadState = { kind: "detached" };

function jjWorkspace(root: string, workingCopyLabel: () => Promise<string | null>): VcsJjWorkspace {
	return {
		root: () => root,
		workingCopyLabel,
	} as unknown as VcsJjWorkspace;
}
function repoInfoFor(root: string): VcsGitRepoInfo {
	return {
		commonDir: `${root}/.git`,
		gitDir: `${root}/.git`,
		gitEntryPath: `${root}/.git`,
		headPath: `${root}/.git/HEAD`,
		repoRoot: root,
		isReftable: false,
	};
}

function gitRepo(head: VcsHeadState | null, _root: string): VcsGitRepo {
	return {
		headSync: () => head,
		linkedWorktree: () => null,
		statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsGitRepo;
}

function unifiedGit(repository: VcsGitRepo, root: string): VcsRepo {
	return {
		kind: () => "git",
		asGit: () => repository,
		asJj: () => null,
		root: () => root,
		watchTarget: () => `${root}/.git/HEAD`,
		statusSummary: (signal?: AbortSignal) => repository.statusSummary(signal),
	} as unknown as VcsRepo;
}

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("StatusLineComponent colocated jj-git label", () => {
	it("prefers the jj bookmark over an attached git HEAD when roots match", async () => {
		const root = "/repo/colocated";
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(gitRepo(attachedHead, root));
		vi.spyOn(vcs, "repo").mockReturnValue(unifiedGit(gitRepo(attachedHead, root), root));
		const label = Promise.withResolvers<string | null>();
		const workingCopyLabel = vi.fn(() => label.promise);
		vi.spyOn(vcs, "jj").mockReturnValue(jjWorkspace(root, workingCopyLabel));

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80);
		expect(workingCopyLabel).toHaveBeenCalled();

		label.resolve("my-bookmark");
		await flush();

		expect(onBranchChange).toHaveBeenCalled();
		expect(component.getTopBorder(80).content).toContain("my-bookmark");
		component.dispose();
	});

	it("keeps the git branch for a nested git checkout under an outer jj workspace", async () => {
		const root = "/repo/nested";
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(gitRepo(attachedHead, root));
		vi.spyOn(vcs, "repo").mockReturnValue(unifiedGit(gitRepo(attachedHead, root), root));
		const workingCopyLabel = vi.fn(async (): Promise<string | null> => "outer-bookmark");
		vi.spyOn(vcs, "jj").mockReturnValue(jjWorkspace("/outer", workingCopyLabel));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		await flush();
		expect(workingCopyLabel).not.toHaveBeenCalled();
		expect(component.getTopBorder(80).content).toContain("git-branch-name");
		component.dispose();
	});

	it("keeps detached for ordinary git with no jj workspace", async () => {
		const root = "/repo/plain";
		vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
		vi.spyOn(vcs, "git").mockReturnValue(gitRepo(detachedHead, root));
		vi.spyOn(vcs, "repo").mockReturnValue(unifiedGit(gitRepo(detachedHead, root), root));
		vi.spyOn(vcs, "jj").mockReturnValue(null);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		await flush();
		expect(component.getTopBorder(80).content).toContain("detached");
		component.dispose();
	});
});
