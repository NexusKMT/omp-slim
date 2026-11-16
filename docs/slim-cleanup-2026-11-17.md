# OMP Slim cleanup — 2026-11-17

This source cleanup follows the review of `99d54bf936` on `main`. At the time
of this report the changes are in the working tree, uncommitted and unpublished.
The diff removes approximately 62,000 net lines, including implementation,
dedicated tests, research code and obsolete documentation. This is a source
measurement; binary size must be measured after a fresh remote build.

## Implementation corrections

- Removed upstream self-update from startup, workers, CLI/slash commands,
  settings, setup and the welcome screen. Removed its install/download and
  binary-delta paths. Retired update settings are discarded during migration.
  Plugin marketplace upgrades remain available.
- Reserved `omp update` and `omp ssh` now report explicit downstream guidance
  before launch, including when preceded by launch flags. Explicit `launch`
  and `--` still allow those words to be used as prompt text.
- Embedded native manifests include SHA-256 digests. Extraction replaces a
  cached addon whose bytes differ even if the version and size match, validates
  decompressed bytes before atomic publication, and checks fallback candidates
  against the embedded manifest before loading. Installed unversioned addons
  no longer pass merely because a few old core symbols exist. Validated bindings
  are reused inside a process so lazy clipboard calls do not rehash the addon.
- Root TypeScript checks now include build and maintenance scripts through
  `check:scripts`. Removed stale `gen:compat`, `gen:models`, metaharness and
  Claude trace entrypoints. The changelog rewriting script requires an explicit
  configured model and uses the model registry's credential resolution.
- Removed stale Go SDK `PredictWord` tests and corrected the remaining error
  variable declaration. Added `test:go` and a manual public SDK validation
  workflow for Go and Python contracts.

## Further removals

- Product build and load targets are macOS Intel and Linux x64, with baseline
  and modern addon variants. ARM targets and the unsuffixed addon fallback are
  removed; the Linux musl release target is retained.
- Removed the unused Apple Foundation Models native bridge and HDiffPatch
  updater-only bindings. Native declarations and generated JS exports agree
  with the reduced source surface. The remote native verifier rejects those
  retired exports.
- Removed tracked metaharness files and Snapcompact research/benchmark files.
  The lockfile drops metaharness, vibemon, protobuf and connect dependencies
  without upgrading retained package versions.
- Removed built-in SSH host discovery, configuration, connection management,
  file transfer, `ssh://` routing, commands, prompts, public exports and their
  dedicated tests. Generic URL approval, authority-port and selector tests now
  register an explicit test protocol. They still check that a lower approval
  tier cannot invoke an exec-tier handler.
- Updated the main English/Chinese README, project guidance, model/provider
  and compaction documentation, CLI reference and affected tool/native docs.
  Historical build records remain identified as historical.

The retained scope includes sessions and resume, editing, shell/PTY execution,
subagents, MCP, HTTP search, manual instructions, local stats, RPC SDKs,
Snapcompact runtime and the native shell/builtin crates. Git SSH transport and
running the terminal application through an SSH session remain supported.

## Completed validation

Local validation used Bun 1.4.4. No full native or standalone product build ran
locally for this cleanup.

| Check | Result |
| --- | --- |
| `bun run check:ts` | Passed: lint/format checks, root scripts and all workspace type checks. Existing lint warnings remain. |
| Final `check:tools` and `check:scripts` | Passed after the last script changes. |
| Focused TypeScript regressions | 271 distinct tests across 29 files passed; 0 failures. Repeat native checks also passed. |
| `bun run test:py` | 104 Python SDK tests passed. |
| `cargo fmt --all -- --check` | Passed; formatting only, no compilation. |
| Frozen dependency installation with lifecycle scripts disabled | Passed; lockfile unchanged. |
| Build shell syntax and SDK workflow YAML | Passed. |
| Changelog CLI help and missing-model rejection | Passed without making a model request. |
| Rewritten documentation links and `git diff --check` | Passed. |

Focused TS coverage includes native extraction and identity checks, CPU target
selection, npm leaf generation, musl release planning, CLI routing/setup,
welcome rendering, settings migration, internal URL approval and selectors,
local read/write/search behavior, plugins, model registry, interrupted thinking
and HTTP search query handling. The native embed test that compiles a standalone
binary was excluded from the local run. The full coding-agent suite was not run.

Validation logs are archived locally in
`dist/validation/cleanup-2026-11-17/` (ignored build evidence). The accompanying
manifest identifies the base commit and hashes changed/new source files, so
these logs can be distinguished from validation of later edits.

## Remote validation still required

Go is not installed on the local machine, so the Go changes have not been
compiled or tested locally. The new workflow is prepared but has not run.

Native inputs changed in this cleanup. Builds from `99d54bf936` or earlier do
not validate these removals, even when their release version is identical.
After this revision is committed and pushed, the remaining sequence is:

1. Run `slim-macos-intel.yml` for a fresh native/CLI build and smoke validation.
2. Run `slim-rust-checks.yml` for Linux Rust formatting, lint, tests and doctests.
3. Run `slim-sdk-checks.yml` for Go/Python SDK contracts. Its default Go command
   does not opt into the separate real-server smoke tests.
4. Run `slim-macos-tests.yml` using the fresh Intel build's `build_run_id`, so the
   full TS suite and standalone package use an addon from compatible inputs.

All workflows remain manual and gated on the public repository. No new Actions
run or release artifact is claimed by this report.
