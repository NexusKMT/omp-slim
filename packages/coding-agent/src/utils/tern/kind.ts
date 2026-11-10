/** The Tern pane omp runs in. */
export interface TernPane {
	/** The Tern daemon socket (`TERN_PANE_SOCKET`). */
	socketPath: string;
	/** The pane omp runs in (`TERN_PANE`), which owns the session. */
	pane: number;
}

/** The Tern pane omp runs in, or null outside Tern (`TERN_PANE_SOCKET` unset or `TERN_PANE` not a block id). */
export function resolveTernPane(env: Record<string, string | undefined> = process.env): TernPane | null {
	const socketPath = env.TERN_PANE_SOCKET?.trim();
	const pane = env.TERN_PANE?.trim();
	if (!socketPath || !pane || !/^\d+$/.test(pane)) return null;
	const id = Number(pane);
	if (!Number.isSafeInteger(id)) return null;
	return { socketPath, pane: id };
}
