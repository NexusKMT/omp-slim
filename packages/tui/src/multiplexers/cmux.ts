import type { TerminalMultiplexerModule } from "./types";

export const cmuxMultiplexer = {
	id: "cmux",
	precedence: "session",
	// CMUX_SOCKET_PATH is a CLI socket override and can be set outside a CMUX terminal.
	sessionEnvKeys: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_REMOTE_TRANSPORT"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT);
	},
} as const satisfies TerminalMultiplexerModule;
