import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { getRepoRoot, git } from "./git";

export interface WorktreeSession {
	id: string;
	branch: string;
	path: string;
	scope?: string[];
	agentId?: string;
	task?: string;
	status: SessionStatus;
	createdAt: number;
	completedAt?: number;
}

export type SessionStatus = "creating" | "active" | "completed" | "merging" | "merged" | "failed" | "abandoned";

async function getSessionsFile(): Promise<string> {
	const repoRoot = await getRepoRoot();
	const result = await git(["rev-parse", "--git-common-dir"], repoRoot);
	let gitDir = result.code === 0 ? result.stdout.trim() : "";
	if (!gitDir) {
		gitDir = path.join(repoRoot, ".git");
	}
	if (!path.isAbsolute(gitDir)) {
		// Resolve relative git dir from repo root to keep sessions in the common dir.
		gitDir = path.resolve(repoRoot, gitDir);
	}
	await mkdir(gitDir, { recursive: true });
	return path.join(gitDir, "worktree-sessions.json");
}

async function loadSessions(): Promise<WorktreeSession[]> {
	const filePath = await getSessionsFile();
	const file = Bun.file(filePath);
	if (!(await file.exists())) return [];
	try {
		const data = await file.json();
		if (Array.isArray(data)) {
			return data as WorktreeSession[];
		}
	} catch {
		return [];
	}
	return [];
}

async function saveSessions(sessions: WorktreeSession[]): Promise<void> {
	const filePath = await getSessionsFile();
	await Bun.write(filePath, JSON.stringify(sessions, null, 2));
}

export async function createSession(params: {
	branch: string;
	path: string;
	scope?: string[];
	task?: string;
}): Promise<WorktreeSession> {
	const sessions = await loadSessions();
	const session: WorktreeSession = {
		id: nanoid(10),
		branch: params.branch,
		path: params.path,
		scope: params.scope,
		task: params.task,
		status: "creating",
		createdAt: Date.now(),
	};

	sessions.push(session);
	await saveSessions(sessions);
	return session;
}

export async function updateSession(id: string, updates: Partial<WorktreeSession>): Promise<void> {
	const sessions = await loadSessions();
	const idx = sessions.findIndex((s) => s.id === id);
	if (idx === -1) return;
	const current = sessions[idx];
	sessions[idx] = { ...current, ...updates, id: current.id };
	await saveSessions(sessions);
}

export async function getSession(id: string): Promise<WorktreeSession | null> {
	const sessions = await loadSessions();
	return sessions.find((s) => s.id === id) ?? null;
}

export async function listSessions(): Promise<WorktreeSession[]> {
	return loadSessions();
}

export async function cleanupSessions(): Promise<number> {
	const sessions = await loadSessions();
	let removed = 0;

	const remaining: WorktreeSession[] = [];
	for (const session of sessions) {
		const exists = await Bun.file(session.path).exists();
		if (!exists) {
			removed += 1;
			continue;
		}
		remaining.push(session);
	}

	if (removed > 0) {
		await saveSessions(remaining);
	}

	return removed;
}
