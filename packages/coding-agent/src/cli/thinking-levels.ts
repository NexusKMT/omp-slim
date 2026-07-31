/**
 * Thinking selectors accepted by the `--thinking` CLI flag, in display order.
 * Shared by help metadata, shell completions, and validation warnings.
 */
export const CLI_THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"auto",
];
