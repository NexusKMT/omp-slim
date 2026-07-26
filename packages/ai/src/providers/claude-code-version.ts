/**
 * Claude Code fingerprint version.
 *
 * Lives in a leaf module (zero imports) so `registry/oauth/anthropic.ts` and
 * `usage/claude.ts` can consume it without dragging in `providers/anthropic.ts`.
 * Importing `providers/anthropic.ts` from the registry path creates a cycle —
 * `providers/anthropic.ts` → `stream.ts` → `registry` → `registry/oauth/anthropic.ts`
 * → back to `providers/anthropic.ts` — and reading this const at module-init time
 * then hits the temporal dead zone (`Cannot access 'claudeCodeVersion' before
 * initialization`). The other Claude Code fingerprint constants stay in
 * `providers/anthropic.ts` because only this one is referenced across that edge.
 */
export const claudeCodeVersion = "2.1.165";
