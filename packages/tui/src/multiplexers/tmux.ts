import type { TerminalMultiplexerModule } from "./types";

export const tmuxMultiplexer = {
	id: "tmux",
	precedence: "session",
	sessionEnvKeys: ["TMUX"],
	termPrefix: "tmux",
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.TMUX);
	},
} as const satisfies TerminalMultiplexerModule;
