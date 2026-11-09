/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Memory backend selector — picks between local memories pipeline,
// Mnemopi local SQLite, Hindsight remote memory, or off. The legacy
// `memories.enabled` flag is migration input only; see config/settings.ts.
// Protocol hosts (RPC/ACP) start with memory off: embedders opt in through their own settings layer.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "hindsight", "mnemopi"] as const,
	default: "off",
	ui: {
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory",
		options: [
			{ value: "off", label: "Off", description: "No memory subsystem runs" },
			{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
			{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
			{
				value: "mnemopi",
				label: "Mnemopi",
				description: "Local SQLite recall/retain backend with optional embeddings",
			},
		],
	},
});
