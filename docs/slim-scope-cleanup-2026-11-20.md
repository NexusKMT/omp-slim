# OMP Slim scope cleanup — 2026-11-20

Baseline: `7237061f7925fce5475907cd53dd5c3337a9f96b`. This pass implements the
requested removal of the unrelated features found in the scope audit. Core
sessions, editing, shell, task subagents, MCP, HTTP search and manual instructions
remain the supported workflow.

## Removed

- Auto-QA, grievances, report_issue, their consent/UI/CLI paths and spool helpers.
- Advisors, Vibe, Autoresearch and built-in personality presets, including tools,
  prompts, settings, registry/UI/RPC integration and feature-specific tests.
- Claude and Jev tokenizer reconstructions, vocabulary data, packers and fixtures.
- Retired provider error classes and subscription/protocol-specific retry branches,
  including Google RPC quota parsing. Generic HTTP status, transport, token-budget,
  quota and schema errors remain supported for configured Chat Completions endpoints.
- The production test-model fallback and catalog-shaped test helper. Model tests
  now construct synthetic fixtures with explicit capabilities.
- Internal model-role APIs and mirror operations. Selection uses `getModel` /
  `setModel`; old main-model selectors and saved session entries remain readable at
  input/migration boundaries. Other model roles cannot enable routing.
- Session analysis/research scripts, upstream publishing scripts, publish-only
  configuration, release tests/commands and archived upstream workflows.

The user-interrupt auto-resume latch now belongs to AgentSession itself, because
IRC and queued messages still need it after Advisor removal. Retired passive
review transcripts are excluded from subagent discovery so reopening an old
session cannot turn a review transcript into an executable task.

Configuration approval, credential masking and panel-clear tests use explicit,
per-test fixture handles. They do not register fake settings in the production
registry. Tests of removed features were deleted; assertions for retained
behavior were adapted. No coverage or test-count target was introduced.

## Validation in progress

Local workspace TypeScript and formatting checks pass. Two focused runs cover
256 tests across 16 files with zero failures: error classification, configuration
approval/redaction/persistence, aside delivery, history formatting, task budgets,
model selection, plan mode, side sessions and terminal model badges.

Native declarations and JavaScript enum exports were updated and Rust formatting
passes. The existing workspace addon predates the tokenizer removal; it is usable
for unchanged interfaces but does not validate the removal. A full remote addon
and standalone build, retained TypeScript suite, Rust checks/tests, recovered
artifact checksums and local platform probes are still required before this pass
is considered validated. Results will be recorded here after completion.

Build-speed investigation uses the audited scripts under `scripts/slim/` and
records source revision, actual Cargo units, cache state and behavior verification.
A stable unchanged build must compile zero units before edit samples are accepted.
Deletion counts alone do not establish a compilation-speed improvement.
