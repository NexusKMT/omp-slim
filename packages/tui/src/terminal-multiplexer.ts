import { cmuxMultiplexer } from "./multiplexers/cmux";
import { herdrMultiplexer } from "./multiplexers/herdr";
import { orcaMultiplexer } from "./multiplexers/orca";
import { screenMultiplexer } from "./multiplexers/screen";
import { tmuxMultiplexer } from "./multiplexers/tmux";
import type { TerminalMultiplexerModule } from "./multiplexers/types";
import { wmuxMultiplexer } from "./multiplexers/wmux";
import { zellijMultiplexer } from "./multiplexers/zellij";

/**
 * Every multiplexer omp recognizes, in classification order within each
 * precedence tier. Adding a multiplexer means adding its module here.
 */
const registry = [
	herdrMultiplexer,
	tmuxMultiplexer,
	screenMultiplexer,
	zellijMultiplexer,
	cmuxMultiplexer,
	wmuxMultiplexer,
	orcaMultiplexer,
] as const satisfies readonly TerminalMultiplexerModule[];

/** Terminal multiplexers omp recognizes. */
export type TerminalMultiplexer = (typeof registry)[number]["id"];

const TERMINAL_MULTIPLEXERS: readonly TerminalMultiplexerModule<TerminalMultiplexer>[] = registry;
const MULTIPLEXERS_BY_ID = Object.fromEntries(
	TERMINAL_MULTIPLEXERS.map(multiplexer => [multiplexer.id, multiplexer]),
) as Record<TerminalMultiplexer, TerminalMultiplexerModule<TerminalMultiplexer>>;
const SESSION_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "session");
const OUTER_APP_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "outerApp");

/** Every environment variable multiplexer classification reads, including the TERM fallback. */
export const TERMINAL_MULTIPLEXER_ENV_KEYS: readonly string[] = [
	...TERMINAL_MULTIPLEXERS.flatMap(multiplexer => multiplexer.sessionEnvKeys),
	"TERM",
];

/**
 * Whether an explicit session marker identifies the current provider.
 *
 * TERM is intentionally excluded: it is a classification fallback, not proof
 * that a particular multiplexer session owns the current grid.
 */
export function hasTerminalMultiplexerSession(
	multiplexer: TerminalMultiplexer,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	return MULTIPLEXERS_BY_ID[multiplexer].isInside(env);
}

function classify(env: NodeJS.ProcessEnv): TerminalMultiplexerModule<TerminalMultiplexer> | undefined {
	const session = SESSION_TIER.find(multiplexer => multiplexer.isInside(env));
	if (session) return session;
	const term = env.TERM?.toLowerCase() ?? "";
	const termFallback = TERMINAL_MULTIPLEXERS.find(
		multiplexer => multiplexer.termPrefix !== undefined && term.startsWith(multiplexer.termPrefix),
	);
	if (termFallback) return termFallback;
	return OUTER_APP_TIER.find(multiplexer => multiplexer.isInside(env));
}

/**
 * Classify which terminal multiplexer hosts the current process, or `null` for
 * a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * Session markers are authoritative. TERM can also survive when those markers
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh), so a
 * `tmux`/`screen` TERM prefix comes next. Outer applications such as Orca rank
 * last so a multiplexer running inside them wins.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	return classify(env)?.id ?? null;
}

/** True when the classified multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classify(env)?.ownsScreenGrid ?? false;
}
