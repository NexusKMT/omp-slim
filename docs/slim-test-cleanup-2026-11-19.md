# Slim test cleanup — 2026-11-19

> Historical audit on the `e8d1f678b3` working tree. The later integration with
> `ea3ca64360` preserves additional remote removals (catalog merged into ai;
> stats, metaharness, research and many old tests removed). Counts and validation
> below describe that earlier tree, not the integrated build. See the build and
> maintenance-cost report for the final source and verification.

This pass removes tests that no longer exercise a supported Slim path, reduces
duplicate assertions, and keeps useful state-transition coverage runnable with
local fixtures. It changes tests and their helpers, not product behavior.

Relative to the working tree at the start of this pass:

- Ten test files removed, with two additional suites simplified and renamed.
- TypeScript tests and helpers reduced by 1,686 physical lines, including the
  replacement local navigation cases. This is a maintenance-size measurement,
  not a quality score.
- One unused endpoint helper and the unreferenced `before-compaction.jsonl`
  fixture removed. The latter is 2,367,896 bytes / 1,003 JSONL lines of test data,
  counted separately from test source. The referenced `large-session.jsonl`
  fixture remains in use by the cut-point regression.

## Decisions and retained coverage

| Area | Evidence and change | Retained behavior |
| --- | --- | --- |
| Old live compaction, hook and RPC suites | Their `ANTHROPIC_API_KEY` gates survived, but their model fixture now points at `models.example.invalid`. The RPC harness also assumes an unconfigured bundled model. Removed `agent-session-compaction`, `compaction-hooks` and `rpc.test.ts`. | Local compaction cancellation, replay-boundary and progress-guard suites; RPC durable history, thinking controls, session opening and bash-context suites. |
| Mixed branching and compaction files | Removed only their gated real-model sections and unused encrypted-reasoning fixture code. | Image draft restoration, branch title ownership, compaction token boundaries and journal reconstruction. |
| Tree navigation | Replaced ten live-model cases with five local cases using the existing mock transport. | Summary attachment at root/user/assistant targets, custom instructions reaching the summarizer, journal preservation, restoration without summarization and abort without mutation. |
| Shared session helper | Removed supplier key lookup and wired scripted transports into both the main agent and side requests. An unscripted model call fails locally. | Existing startup, navigation, fork and transition tests continue to run without model service credentials. |
| Empty files and thin wrappers | Removed empty advisor/compaction files, two tests of literal `mode === "on"` decisions, and the standalone Buffer Base64 wrapper check. | Session message pipeline, prompt/tool rendering and real image resize tests cover the consuming behavior. |
| Old catalog fallback reproduction | Removed `repro-issue-1022-disabled-default-model`: its now-empty registry cannot exercise the claimed competing-provider selection. | Explicit endpoint rejection remains in `config/manual-model-resolver`; current CLI selection tests use a real configured competing endpoint. |
| Slash-containing model IDs | Folded four supplier-labelled parser/CLI cases into the manual resolver suite. | Both literal `namespace/model` and qualified `gateway/namespace/model` resolve through the CLI boundary. |
| Background helper roles | Renamed the remaining annotation case to `annotation-summary-model`; removed the literal commit-budget check and title test already covered by `title-generator`. | The exact active model and session credential resolver still reach annotation summarization. |
| Extension model selection | Replaced the duplicated legacy/default-setting matrix with `sdk-extension-model-selection`. Added an actual configured competing model; the old competitor existed only as credentials. | The configured extension model wins after registration; legacy settings migration remains in `config/single-model-settings`. |
| CLI model selection | Removed the retired discovery mock and repeated migration row. Replaced the disconnected `ANTHROPIC_BASE_URL` fake service with an endpoint declared in `models.yml`. | Missing CLI/configured models fail without contacting an available alternative or suggesting another provider's model. |
| Protocol/configuration assertions | Reduced repeated API-name rows that take the same rejection branch; removed constructor field-echo assertions. | Unsupported API rejection at model construction, configuration and both stream entrypoints; actual endpoint/header behavior remains covered by the Chat Completions and configuration integration suites. |

Provider names in historical message fixtures, secret-filter tests and tests
proving that names cannot select a proprietary transport remain valid inputs.
The opt-in live Chat Completions tests also remain; this pass did not invoke a
real model endpoint. No source-text assertion tests were added.

## Verification

`bun run check:ts` passed on the final TypeScript changes: lint/format checks,
script checks and all package type checks. The linter still reports existing
warnings elsewhere. `git diff --check` passed.

Focused tests passed with zero failures. Counts below exclude the six catalog
tests repeated in the initial navigation run:

| Group | Cases | Files |
| --- | ---: | ---: |
| AI and catalog, excluding opt-in live endpoints | 862 | 54 |
| Model configuration, SDK selection, helper/title behavior and Slim configuration integration | 71 | 7 |
| Session transitions, forks and compaction | 143 | 8 |
| Startup composer and terminal clearing | 20 | 2 |
| RPC durable history, bash context and session opening | 14 | 3 |
| CLI selection, image resizing and runtime-specific tool guidance | 38 | 3 |
| Tree navigation, image drafts and skill prompts | 13 | 3 |
| **Distinct total** | **1,161** | **80** |

This was a focused audit of obsolete supplier/model fixtures and duplicate
coverage, not a line-by-line review or full execution of the entire repository's
test suite. File deletion is supported by current behavior and call-site checks,
not by a target test count or coverage percentage.
