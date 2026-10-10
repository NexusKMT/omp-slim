import type { TerminalMultiplexerModule } from "./types";

export const screenMultiplexer = {
	id: "screen",
	precedence: "session",
	sessionEnvKeys: ["STY"],
	termPrefix: "screen",
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.STY);
	},
} as const satisfies TerminalMultiplexerModule;
