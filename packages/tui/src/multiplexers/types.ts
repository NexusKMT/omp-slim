/**
 * Classification tier. `session` markers outrank the TERM fallback; `outerApp`
 * hosts rank below it so a multiplexer nested inside them still wins.
 */
export type TerminalMultiplexerPrecedence = "session" | "outerApp";

/** Everything omp needs to recognize one terminal multiplexer. */
export interface TerminalMultiplexerModule<Id extends string = string> {
	readonly id: Id;
	readonly precedence: TerminalMultiplexerPrecedence;
	/** Every environment variable `isInside()` reads. */
	readonly sessionEnvKeys: readonly string[];
	/** Lowercase TERM prefix that identifies the multiplexer when its session markers were stripped. */
	readonly termPrefix?: string;
	/**
	 * Whether the multiplexer owns the screen grid. When true, rendering takes the
	 * multiplexer path (no scrollback rebuild, anchored resize, skipped probes).
	 */
	readonly ownsScreenGrid: boolean;
	isInside(env?: NodeJS.ProcessEnv): boolean;
}
