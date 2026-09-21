import type { SessionEntry } from "../../session/session-entries";
import type { RpcResponse } from "./rpc-types";

/**
 * Slice canonical append-history for the Pi-compatible `get_entries` command.
 *
 * Delegates to the canonical `SessionManager` entry list (append order) and
 * applies only the `since` cursor — never a second history/indexing layer.
 *
 * - no `since` → all entries in append order;
 * - `since` → entries strictly after the matching durable entry;
 * - unknown `since` → throws; the caller maps it to an explicit RPC failure;
 * - always passes through the current `leafId` unchanged.
 */
export function selectRpcEntries(
	entries: readonly SessionEntry[],
	leafId: string | null,
	since?: string,
): { entries: SessionEntry[]; leafId: string | null } {
	if (since === undefined) return { entries: [...entries], leafId };
	const index = entries.findIndex(entry => entry.id === since);
	if (index === -1) throw new Error(`Unknown entries cursor: ${since}`);
	return { entries: entries.slice(index + 1), leafId };
}

/**
 * Error response for an unknown RPC command that preserves the caller's
 * correlation id. Malformed frames without a trustworthy id stay uncorrelated
 * at the transport layer; this covers only parsed commands that reached the
 * dispatcher with an id.
 */
export function rpcUnknownCommandResponse(command: { type: string; id?: string }): RpcResponse {
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: false,
		error: `Unknown command: ${command.type}`,
	};
}
