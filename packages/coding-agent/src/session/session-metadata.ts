/** Optional request metadata uses only the local session ID. */
export function buildSessionMetadata(sessionId: string): Record<string, unknown> {
	return { session_id: sessionId };
}
