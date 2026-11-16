import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";

/** Remote resource whose access must be rejected before the handler runs. */
export const execUrlProtocol: ProtocolHandler = {
	scheme: "execfs",
	spec: {
		backing: "remote",
		selectors: "lines",
		portAuthority: true,
		immutable: false,
		readTier: "exec",
		write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" },
	},
	resolve: async () => {
		throw new Error("execfs resource must not resolve without approval");
	},
	write: async () => {
		throw new Error("execfs resource must not write without approval");
	},
};
