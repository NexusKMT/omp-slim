import type { TerminalMultiplexerModule } from "./types";

export const zellijMultiplexer = {
	id: "zellij",
	precedence: "session",
	sessionEnvKeys: ["ZELLIJ"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.ZELLIJ);
	},
} as const satisfies TerminalMultiplexerModule;
