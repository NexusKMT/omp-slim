/** Explicit user, extension or programmatic cancellation of compaction. */
export class CompactionCancelledError extends Error {
	override readonly name = "CompactionCancelledError" as const;
	constructor(message = "Compaction cancelled", options?: ErrorOptions) {
		super(message, options);
	}
}
export type CompactionOutcome = "ok" | "cancelled" | "failed";
