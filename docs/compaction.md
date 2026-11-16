# Context compaction in OMP Slim

Compaction reduces the active conversation while preserving a durable session
history. Summaries and retained recent entries become the context for later
requests; stored session entries remain available for history and resume.

OMP Slim uses the selected main model for every summarization request. Model
roles, automatic alternate-model routing, provider-native compaction protocols
and separate remote summarizer endpoints are removed.

## Available methods

The default automatic preference order is `snapcompact`, `handoff`, `shake`,
then `soft`. The implementation and availability checks live in
[`compaction-methods.ts`](../packages/coding-agent/src/session/compaction-methods.ts).

| Method | Behavior |
| --- | --- |
| `snapcompact` | Archives history into bitmap frames for an explicitly image-capable model, without an LLM summarization request. |
| `handoff` | Generates a handoff document with the current model and uses it as the compaction summary. |
| `shake` | Drops recoverable heavy content in place without an LLM request. |
| `soft` | Summarizes history in place with the current model. |

Unavailable methods are skipped according to the configured method order.
Snapcompact requires image input on the wire; declaring a text-only endpoint
does not enable it. Its runtime remains in `packages/snapcompact`; the separate
research and benchmark code is removed.

Manual compaction, automatic threshold handling, overflow recovery and
speculative summaries are coordinated by
[`session-maintenance.ts`](../packages/coding-agent/src/session/session-maintenance.ts).
Async speculation applies to the LLM-backed `handoff` and `soft` methods;
local bitmap/pruning methods do not start a speculative model request.

## Summary and history handling

The engine in
[`compaction.ts`](../packages/agent/src/compaction/compaction.ts) prepares a cut
point and retained tail, serializes the older conversation, and generates a
summary from static prompts. Oversized input is folded through budgeted windows
with the previous summary carried forward. Context-overflow errors can reduce
the rejected window; failures still surface when a usable window cannot be
produced.

Summary, iterative update, split-turn and handoff prompts live in
[`compaction/prompts`](../packages/agent/src/compaction/prompts). Cumulative
file-operation information helps later requests recover which files were read
or modified. Session maintenance commits the summary against the relevant
branch and handles cancellation or stale speculative work.

Handoff integration lives in
[`session-handoff.ts`](../packages/coding-agent/src/session/session-handoff.ts).
Branch-switch summaries are prepared by
[`branch-summarization.ts`](../packages/agent/src/compaction/branch-summarization.ts).
Both use the same selected-model contract as ordinary requests.

## Configuration and extension hooks

Use `/settings`, `omp config`, and [settings documentation](settings.md) to
configure automatic compaction, thresholds, retained context and method order.
Current settings are read through
[`context-settings.ts`](../packages/coding-agent/src/session/context-settings.ts);
retired remote-compaction settings are removed during settings migration.

Extensions may participate through the session compaction and tree hooks.
They must preserve branch, cancellation and history consistency. See
[extensions](extensions.md), [model configuration](models.md), and
[the single-model report](slim-single-model.md).
