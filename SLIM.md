# OMP Slim

Public downstream: https://github.com/NexusKMT/omp-slim

The source baseline is upstream v18.18.3, commit
`21f1188cf88b2f534c092181968cd5a4d1a9c296`. The original MIT license and
third-party notices are retained. `upstream` points to can1357/oh-my-pi;
`origin` points to this downstream repository.

The requested scope is removal of built-in browser automation, host desktop
control, speech/live audio, and automatic long-term memory, followed by independent model roles and automatic alternate-model routing. Session storage,
resume/history, context compaction, file editing, shell execution, subagents,
ordinary HTTP search, MCP and manually maintained instructions remain core.

Current product targets are **macOS Intel and Linux x64**. Built-in SSH host
management and `ssh://` file transport, upstream self-update, Apple Foundation
Models, update-only binary patching, metaharness and Snapcompact research code
are removed. The Snapcompact runtime, RPC interface and TypeScript SDK remain.
Local stats, runtime telemetry, Nix integration and the separate Go/Python SDKs
have also been removed; model metadata now lives in `packages/ai`.
Native caches are checked against embedded SHA-256 digests, including same-version
builds with equal file sizes. `bun run check:ts` also checks root build scripts.
This cleanup changes native inputs and requires a fresh full build; older
validation records below apply only to the source revisions they name.
See the [2026-11-17 cleanup report](docs/slim-cleanup-2026-11-17.md) for the
implemented removals, local regression results and remaining remote checks.

AST WASM grammars are disabled by default. Structural operations retain Bash,
C/C++, CSS, Diff, Go, HTML, Java, JavaScript, JSON, Markdown, Python, Regex,
Rust, TOML, TSX/TypeScript and YAML. Other registered languages are skipped by
structural operations without downloading modules, including when an older
build left cached grammars. Ordinary text operations remain available.
An explicit `OMP_NATIVE_FEATURES=wasm-grammars` native build restores optional
grammar loading. `slim-macos-intel.yml` accepts `compare_wasm=true` and a fixed
`benchmark_cache_key` to compare both builds against the same restored cache;
it records native/CLI/PTY timings, dependency graphs and addon sizes.
The [2026-11-17 comparison](docs/slim-wasm-build-2026-11-17.md) passed both modes:
the default addon shrank by 5.67 MB, but the first build from the old WASM cache
was slower. The report separates compilation, cache restoration and tests.

The macOS PTY regression command now builds `pi-pty`, the small output-drain
crate also used by the native addon, and matches napi's explicit Cargo target.
The workflow additionally tests `PtySession` through the freshly built addon.
`compare_optimization=true` compares O3 ThinLTO, O3 without LTO, and workspace
O2 without LTO against a fixed cache. It measures both the first native build
and a second addon build with its dependencies already compiled, so a change
of Cargo profile is not confused with the cost of an ordinary addon edit.
The `ci` profile now retains O3 and disables LTO: addon-only compilation fell
from 10m 03s to 2m 46s, while the isolated PTY command takes 8s. The first build
after changing profiles must populate the new dependency cache. See the
[build-performance report](docs/slim-build-performance-2026-11-17.md) for all
three configurations, validation results and measurement limits.

## Development feedback

The goal is to see the effect of each edit quickly. With a verified native
addon installed in `packages/natives/native/`, ordinary TypeScript changes use
the existing source entrypoint:

```sh
# From the repository root; restart the CLI after an edit.
bun run dev

# Worker/service smoke without a model request or standalone build.
bun run dev --smoke-test

# First check the affected behavior and package.
bun test packages/coding-agent/test/<file>.test.ts
bun --cwd=packages/coding-agent run check:types
```

`bun run dev` runs in `packages/coding-agent/`. To run the source CLI against
another project, invoke its absolute entrypoint from that project's directory:
`bun /path/to/omp-slim/packages/coding-agent/src/cli.ts`. These commands use the
normal agent configuration; use `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` to
isolate experiments. TypeScript source changes do not require `bun setup`,
`build:native`, CLI packaging, or a new Actions job. Native API or implementation
changes do require a matching new addon; matching package versions alone does
not prove that the addon contains the current Rust implementation.

For Rust edits, start with the affected crate instead of selecting the whole
workspace. The test wrapper preserves doctests and accepts a nextest filter:

```sh
CARGO_INCREMENTAL=1 bun run check:rs --package pi-pty
CARGO_INCREMENTAL=1 bun run test:rs --package pi-pty
CARGO_INCREMENTAL=1 bun run test:rs --package pi-pty -E 'test(cancel)'
```

Keep the same Cargo profile, flags and target directory between edits. Small
independent crates can be checked locally. The explicit incremental setting is
needed even locally when OMP's shell injects `CI=true`. Plain Cargo defaults to
`dev`, but `bun run build:native` defaults to the O3/ThinLTO `local` profile;
select `OMP_NATIVE_CARGO_PROFILE=dev CARGO_INCREMENTAL=1` explicitly for a remote
development build. Full native compilation still uses
the authorized remote build path. The `ci` timings above are not measurements
of a persistent incremental Rust development environment. Full workspace
validation and standalone packaging are integration gates, separate from the
first feedback after an edit.

The workspace addon was refreshed during the 2026-11-20 audit from verified
build `44549416311`, native source `ae480c973c183d9ca66fc19a25ed6a7d8546418d`
(O3 without LTO). Its SHA-256 is
`2fbb3b6dc96cfb6ec0462f93fc91569973e1534180e14f73955cc06d95553386`.
The source CLI had been loading an older same-version addon with retired exports;
the audit backed it up and verified the replacement with export checks, worker
smoke and PTY/shell tests. The record is in
`dist/validation/build-audit-2026-11-20/workspace-native-installation.json`.
The previous file is backed up in `workspace-native-backup/` under that evidence
directory. The earlier [development feedback measurements](docs/slim-build-performance-2026-11-17.md#local-development-feedback)
record source smoke at 6.98s, four PTY binding tests at 1.86s, and the initial
focused Rust test command at 11.03s. A temporary source-edit probe observed the
CLI change in 0.28s and caught a Rust cancellation regression in 3.28s; restoring
the implementation passed in 3.77s. These are local command timings, not full
native rebuild timings.

The manual macOS workflow accepts `compare_development=true` to measure the
existing `dev` and `local` profiles on separate Intel runners. It defaults to
`development_profile=dev` and `benchmark_scope=quick` (one native edit).
Choose `development_profile=both` and `benchmark_scope=full` for three distinct behavior
changes to the same native tab-width function. Every sample rebuilds and
installs the addon, verifies the changed result in a fresh Bun process, and
runs source worker smoke. It restores the original source and addon before
PTY, shell-session, grammar and export checks. Profile-specific warm caches
are saved before edits; the evidence artifact includes per-command timings,
Cargo timing reports and source restoration. Validated addon checksums and
binaries are produced only when the complete restoration test gate passes.
These samples measure function-body edits in one retained checkout, excluding
job startup and cache restoration. They do not measure dependency/API changes
or a complete interactive remote editing service.

Both development experiment jobs explicitly set `CARGO_INCREMENTAL=1` and
reject an effective Cargo unit graph that disables incremental for the three
target crates. The pinned Cargo disables incremental by default under `CI`,
even when Cargo.toml enables it. The first completed comparison and matrix
therefore measured cached-dependency rebuilds with incremental disabled:
native edit medians were 578.7s (`local`) and 60.5s (`dev`); the instrumented
matrix measured about 30–43s for native edits, 200–234s for shell edits and
288–329s for builtins edits. A later successful run on 2026-11-18,
`44300999380`, did enable incremental: its one native edit took 26.125s to build
and install, or 29.530s through behavior verification and worker smoke. It used
the older `dev` LTO setting (`false`, not the current `"off"`), so it does not
validate the current profile or establish a repeated-sample speedup. This run
was recovered during the [2026-11-20 audit](docs/slim-build-audit-2026-11-20.md).
That audit also completed `44562078213` with the current `dev` profile:
three native edits took 26.907 / 16.420 / 23.421s through behavior verification
and worker smoke (median 23.421s), each rebuilding one native unit. The initial
uncached warm build took 1880.567s. These are separate costs; the samples do not
measure shell edits, cross-job restoration or runtime performance parity.
See the
[compiler investigation](docs/slim-compiler-investigation-2026-11-17.md) for
raw evidence, limits, failed final session tests and their test fix.

For deeper investigation, `compiler_matrix=true` defaults to one native edit
with one frontend thread. With `benchmark_scope=full`, it selects `dev` builds
with 1, 2 and 4 frontend threads on `pi-natives`, `pi-builtins` and `pi-shell`.
Cargo remains limited to four jobs. Each configuration establishes a separate
checkpoint and performs three actual function-body changes per crate, verifying
the new addon behavior and source worker smoke after each change. The rustc
wrapper preserves Cargo's jobserver descriptors and records JSON pass timings
for the selected crates; fingerprint logs explain why Cargo rebuilt each unit.
Pass timings can nest or overlap and must not be added together. Checkpoints
record source SHA-256 and timestamps; only byte-identical tracked files regain
their prior timestamps. New instrumentation forces the selected crates once
before the measured edit sequence. The matrix uploads diagnostic evidence,
not experimental binaries.

## Build and removal history

The baseline was built before removal. Browser, desktop, speech and memory were
then removed in four isolated worktrees and integrated on `main`. At most five
agents may run concurrently, including the coordinator; workers must not spawn
child agents. A disabled setting alone is not evidence that a component has
been removed from the product. Track the actual state below.

| Stage | State |
| --- | --- |
| Public repository and pinned upstream baseline | Established; made public at the user's request on 2026-11-10 |
| Repeatable Codespace bootstrap/build/artifact procedure | Baseline built; binary and archive recovered and SHA-256 verified |
| Sharpshooter memory backend removal | Committed as `88a81dd819`; `bun check`, 238 focused tests and compiled-binary worker smoke passed |
| Other memory backends, browser, desktop and speech removal | Removed from source, registration, workers, UI, dedicated tests/docs and native backends; rebuilt addon export checks, full Rust checks and all 219 Mac TS groups passed |
| Dependency cleanup | Cargo packages 979 → 799, Bun packages 462 → 396; no new package versions; two dedicated workspaces removed |
| Single main model | Implemented and built at `d55687e514`; local binary/config/RPC verification passed. Cloud suite: 212/213 groups; the sole DAP fixture race was fixed in `34b93cb6a7`, and its full 10-file group passed locally (200 tests). Roles and automatic alternate-model routing removed. See [the single-model report](docs/slim-single-model.md). |
| Chat Completions as sole transport | Merged as `dc7858ea37` with catalog cleanup `d7dfe88353`; vendor catalog, provider auth flows and protocol routing retired. `packages/coding-agent` typechecks clean; the retained core suites (`snapcompact*`, `mcp*`, `rpc*`, `interactive-mode*`) pass; the shrunken RPC wire schema was regenerated via `gen:rpc`. TS-only change, build verified by reusing Intel addon `42807753137` in `slim-macos-tests.yml`. See [the removal report](docs/slim-removal-2026-11-10.md) |
| Chat Completions test-suite reconciliation | Removed-provider/protocol tests deleted (9 whole suites: provider-options parity, context-fit model selection, prompt-variant editing, `task`/`vibe` prompt-cache suites, RPC schema validation, registry mirror fixture; 127 more tests inside kept suites, incl. the cache-warming half of `rpc-auto-maintenance-scope`, whose retained #11431 scoping tests were re-authored). Retained-feature tests re-authored with explicit fixtures: `snapcompact*` frame caps and text-only/wire-stripped models pinned to the retained 3 MB frame byte budget, model-availability and custom-model auth harnesses re-keyed, and registries bound to `Settings.isolated()` so a settings-less registry can't inherit the developer's real disabled-provider config from the global singleton. Verification: 2,196 tests across 182 files, 0 fail; `bun check` clean in 3,688 files. |
| Intel macOS Actions build | Final native/CLI source `d7f1646f90` compiled in `42807753137`; local binary verification, 120 PTY output probes and actual spelling passed; complete TS validation `42819306007` passed 219/219 groups |
| Code trim: dead providers' tail | Executed from the 2026-11-12 audit (`docs/slim-audit-2026-11-12.md`): removed pi-predict prediction engine (kept `apple::appkit` spelling shim used by `pi_natives::spelling`), redis/sql session storages + SDK examples, azure compaction endpoint, judgment cache + `hasNativeJudge`/`JudgeKind` native-local branches, predict worker wiring, and dead provider help text (help-extra, main.ts key hint, doctor checks). Generated `TextPredictor` declarations and the JS shim were removed by binding regeneration in `c6c5d4521e` on 2026-11-13. Verification: `cargo check -p pi-predict` and `-p pi-natives` exit 0; `bun check` clean in all 8 packages (coding-agent 3,523 + metaharness both tsconfigs + agent/catalog/ai/tui/natives/utils); affected suites 39/0 (`judgment-chain`, `auto-graph-planner`, `jfind*`) plus `ttsr-judged-rules`+`session/*` 289 pass (5 pre-existing `formatSessionDumpText` fails, see below), utils package 100%. One self-inflicted regression (planner `kindQuestion` removed while `judgeRequest` still calls it) caught and fixed. Full local `bun test`: 14,180 pass / 405 fail / 15 err — triaged: ~370 are this machine's real `~/.omp/agent/models.yml` (moxuna-only, no anthropic key) shadowing the clean-home fixtures CI relies on; the rest are pre-existing drift from pushed commits 0d73ddd567 (`sendsImageInputOnWire` completions-only vs retained `openai-responses`/`anthropic-messages` test fixtures) and dd8123f1a8 (JSON `renderToolInventory` vs tests still pinning TS-signature `/dump` rendering) plus full-run-only timing flakes (e.g. `snapcompact-trigger-room` passes 18/0 alone); zero failures trace to this session's touched files. CI remains the authoritative full gate. |
| Maintenance-script cleanup (2026-11-19) | Five model-backed maintenance tools now resolve the configured main Chat Completions model; broken trace/version-check commands and obsolete test fixtures removed; Nix dependencies regenerated. Full TS checks, 140 script tests, focused regressions and source CLI smoke passed locally. See [the maintenance report](docs/slim-maintenance-2026-11-19.md) for scope and validation limits. |
| Heuristic audit reconciliation (2026-11-19) | H1–H9 repaired: cleanse model inheritance, benchmark config export, Python Chat Completions bridge, configured benchmark defaults, dead commands/docs and profile-scoped audit paths. Retained benchmarks and maintenance scripts now participate in type checks; retired supplier experiments have been deleted, including their temporary text archives. Full TS checks, 145 script tests, 154 focused package tests (1 skip), local Python integration and source smoke passed. See [the repair report](docs/slim-heuristic-fixes-2026-11-19.md). |
| Supplier research cleanup (2026-11-19) | Deleted supplier experiments and text archives, fixed-checkpoint analysis, orphan prompts, upstream Pi comparator, unused bridge/prompt and retired protocol docs (122 source files total across the two cleanup passes). Full TS checks, 213 focused tests, both Python QA entries, five renderer parity cases and source smoke passed. See [the cleanup report](docs/slim-supplier-cleanup-2026-11-19.md). |
| Test cleanup (2026-11-19) | Removed obsolete live suites, empty/redundant tests and an unreferenced 2.37 MB fixture; retained tree-navigation behavior now runs locally. Test/helper source reduced by 1,686 lines. Full TS checks and 1,161 distinct focused tests passed. See [the test cleanup report](docs/slim-test-cleanup-2026-11-19.md). |
| Integration and maintenance-cost assessment (2026-11-19) | Source `ae480c973c` incorporates the 48 intervening remote commits and the applicable cleanup. The preceding four November 19 reports describe the earlier `e8d1f678b3` tree; some of their consumers/tests were subsequently removed. Intel build [44549416311](https://github.com/NexusKMT/omp-slim/actions/runs/44549416311) compiled and passed worker smoke, PTY and TS checks; the full TS gate passed 135/157 groups. A real rules-injection regression was repaired in `06ef50a1ea` (40 local behavior tests pass); [44556806308](https://github.com/NexusKMT/omp-slim/actions/runs/44556806308) compiled the repaired CLI using the verified addon and passed 136/157 TS groups. The full gate remains failed. Both archives were recovered and SHA-256 checked; repaired CLI signature/local smoke and actual addon spelling passed. See [the current assessment](docs/slim-maintenance-cost-2026-11-19.md) for scope, checksums and remaining failures. |
| Build audit and main validation (2026-11-20) | Audit fixes pushed as `8e3f7ea1d0`: lock Cargo metadata/build inputs, reject benchmark no-op samples with compiled units, and correct incremental/profile claims. Intel run [44571654491](https://github.com/NexusKMT/omp-slim/actions/runs/44571654491) passed native/CLI build, worker smoke, 7 Rust PTY tests, 4 binding PTY tests and TS checks. Native build/install took 500s; CLI build 41s. Full TS remains 136/157 groups passed, with the same 21 failed groups and failure behaviors after resolving one duplicate ReportPanel file attribution. All artifacts were recovered and SHA-256 verified; local CLI signature/smoke and real addon spelling passed. Source and generated bindings stayed clean. See [the audit](docs/slim-build-audit-2026-11-20.md) for measurements, limitations and checksums. |
| Retained-test reconciliation and green main (2026-11-20) | `136570d870` removes obsolete tests and fixes final assistant message delivery/persistence before tool dispatch, inline tool descriptions, and readable skill addresses. `f37c6d4688` aligns the remaining skill-toggle assertions. Final Intel run [44584226996](https://github.com/NexusKMT/omp-slim/actions/runs/44584226996) passed **157/157 TS command groups, 0 failed** in 635.0s, plus TS checks and a freshly compiled CLI using the verified compatible addon from `44571654491`. Five obsolete/empty test files removed; tests net −652 lines. Both rounds' artifacts and logs recovered with SHA-256 checks; local CLI signature/worker smoke and two real AppleSpell tests passed. See [the reconciliation record](docs/slim-test-reconciliation-2026-11-20.md) for the first round's 156/157 result, retained behavior, exact hashes, remaining lint warnings and measurement limits. |

As of 2026-11-10 (Asia/Shanghai), Codespace
`omp-slim-build-vrxqgpxrj7gfp579` was verified **Shutdown** after both Linux builds
and again after the macOS Actions build. Retention is 72 hours. Its checkout is
`88a81dd819`; later build/workflow and report commits are on GitHub and local
`main`. List and verify live state
again before reuse. The failed first instance was deleted.

Browser removal must account for Chromium-backed PDF page screenshots, web-search
fallbacks and cookie-capture login. Preserve PDF text extraction and HTTP search;
remove browser-dependent fallbacks explicitly. Standard OAuth callbacks and API
keys remain supported. Long-term memory removal must not erase stored sessions.
`ttsr` means Time-Traveling Stream Rules, and Rust `memory.rs` manages the native
heap; neither belongs to the memory/speech removal scope.

The integrated removal includes the Chromium/Puppeteer runtime and installer,
browser relay/extension, browser-backed search/PDF/cookie-login paths, native
desktop control on all three operating systems, STT/TTS/live audio and
`pi-voice`, all automatic memory backends and learning jobs, `packages/mnemopi`,
and its dedicated native vector kernels. Generic provider protocol/catalog
types remain for SDK consumers and history compatibility. Codex attestation
was moved intact into `config/` because ordinary Codex requests also use it.
Manual skill management remains explicit through `manage_skill`.

Old browser/desktop/memory settings are retired on load/save without removing
stored user files. Old speech configuration remains inert data and cannot
reactivate removed tools. Existing sessions, manually managed skills and
instructions remain readable. See [the full removal report](docs/slim-removal-2026-11-10.md)
for scope, verification and dependency measurements.

## Codespace procedure

Use GitHub account **NexusKMT** and repository **NexusKMT/omp-slim**. Check both
before changing instance state. Historical instance names are not reusable facts:
list current instances, select this repository and verify the branch. Create a
new one only when no suitable instance exists. An ambiguous create response must
be reconciled with the inventory before retrying.

```sh
gh auth switch --hostname github.com --user NexusKMT
gh api user --jq .login
gh codespace list --repo NexusKMT/omp-slim
gh codespace create --repo NexusKMT/omp-slim --branch main \
  --machine standardLinux32gb --display-name omp-slim-build \
  --idle-timeout 30m --retention-period 72h --default-permissions
```

Use the returned instance name for every SSH, copy and stop command. Verify
`gh api user/codespaces/NAME` names this repository. Wait for `Available`; then
verify SSH, the actual source commit, and available disk/memory. Do not print
credential environments or copy local Codex histories into the cloud repository.

The retired app-ops implementation was consulted for lifecycle lessons only.
Do not restart its Flowise/Dagu services. The applicable historical lessons are
identity checks, instance reconciliation, explicit source revisions, durable
logs/artifacts, SHA-256 verification, and confirming shutdown.

## Build procedure

Reference implementations: `packages/coding-agent/DEVELOPMENT.md`,
`docs/natives-build-release-debugging.md`, `packages/natives/scripts/verify-addon.ts`,
`packages/natives/scripts/build-bindings.ts`, and
`packages/coding-agent/scripts/build-binary.ts`.

The Codespace uses `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` with
the `vscode` user and the official `sshd` devcontainer feature. The bootstrap
installs Bun 1.4.4 and the toolchain pinned by
`rust-toolchain.toml`, plus Linux native build tools and frozen JS dependencies.
The host native build uses Cargo/N-API. Release addons are built on each target
platform; a Linux host binary is not a macOS deliverable.

```sh
bash scripts/slim/bootstrap.sh
bash scripts/slim/build.sh baseline
```

Build logs, source revision, result status and artifacts are written to
`dist/builds/<label>-<timestamp>/`; `dist/builds/latest` names the last run. Rust
intermediates use `/tmp/omp-slim-cargo-<uid>` by default. Check the real mounts
before a long build: temporary storage size varies and does not imply persistence
across rebuilds, stops or deletion. Build failure leaves the log and exit status.

Recover both the archive and its checksum, verify locally, and preserve the log
and source revision. Stop the instance after the task and verify `Shutdown`,
unless the user explicitly asks to keep it running. Shutdown retains storage;
automatic retention is set to 72 hours. Do not delete an instance while it holds
the only copy of work or artifacts.

### Transport and setup findings

The initial `universal:2` container failed during `apt-get update` because its
unrelated Yarn repository had an untrusted signing key. The base Ubuntu image
avoids that extra repository. The bootstrap checks every required build package
with `dpkg-query` before installing missing packages.

The minimal image needs the explicit `sshd` feature for `gh codespace ssh`.
Bootstrap also runs `rustc --version` once to finish the components and targets
declared in `rust-toolchain.toml` before checks and builds run concurrently;
otherwise both rustup processes can race while installing the same component.

On this machine, `gh codespace cp` passed quoted paths literally to the SFTP
server. Use `gh codespace cp --expand` with explicit, controlled paths. The first
SSH shell also lacked GitHub HTTPS credentials, so source synchronization used
a Git bundle over the authenticated Codespace connection. No local token was
copied into the instance. For a later incremental update:

```sh
# Replace BASE with the actual commit currently checked out in the Codespace.
git bundle create /tmp/omp-slim-update.bundle main ^BASE
gh codespace cp --expand -c NAME /tmp/omp-slim-update.bundle remote:/tmp/omp-slim-update.bundle
gh codespace ssh -c NAME -- 'cd /workspaces/omp-slim && git fetch /tmp/omp-slim-update.bundle main && git merge --ff-only FETCH_HEAD && git rev-parse HEAD'
```

Compare the returned commit to the local source before building. A dirty remote
checkout must be inspected before synchronization; do not reset it to make an
update succeed. Codespace `Available` means the shell can connect, not that
`postCreateCommand` succeeded; check the creation log and tool versions.

## Validation

The latest single-model application build and hashes are in
[the single-model report](docs/slim-single-model.md). Its recovered executable is
`dist/actions/42867271630/artifact/reused-cli-d55687e51411da0d209adb1a0d746cbf236d0bec/extracted/omp`.
Compilation and local verification passed. The full cloud run passed 212/213
command groups; the unrelated DAP fixture race was then corrected and its
complete failing group passed locally. The cloud run remains marked failed;
the earlier green run documented below belongs to the four-feature removal.

The build script checks the produced binary's version/help and worker smoke test.
This does not replace feature regression tests. Follow upstream `AGENTS.md`:
`bun check`, targeted Bun tests, and `bun run test:rs` for Rust changes. Report
baseline failures separately from regressions. Never treat a passing build as
proof of real provider authentication or of completed feature removal.

The fully trimmed tree uses manual public workflows: `slim-macos-intel.yml`
rebuilds and tests the macOS artifact and retained TypeScript workspace;
`slim-rust-checks.yml` runs Rust formatting/lint plus nextest and doctests on
Ubuntu 24.04. `slim-macos-tests.yml` verifies and reuses a compatible addon for
TS-only iteration. All are gated on public visibility. The Rust job uses the
repository's `check:rs` / `test:rs` wrappers and does not need a Codespace.

[Rust run 42806432208](https://github.com/NexusKMT/omp-slim/actions/runs/42806432208)
passed formatting, Clippy, all 6,367 runnable nextest tests (16 skipped), and
all six runnable doctests (28 ignored). Final Mac build
[42807753137](https://github.com/NexusKMT/omp-slim/actions/runs/42807753137)
passed native/CLI compilation, signing/load-path checks, worker smoke and all
ten selected native PTY regressions. The recovered executable passed local
checksums, version/help, worker smoke, shell/file behavior and compiled HTML
session export. The final addon passed 120 concurrent PTY output probes with
zero failures and both actual AppleSpell checks locally. The hosted workflow
explicitly skips one spelling service integration because NSSpellServer times
out there.

Complete TypeScript verification passed as
[42819306007](https://github.com/NexusKMT/omp-slim/actions/runs/42819306007):
219/219 command groups, zero failures, with the same verified native addon.
The entire TS validation job took 28m41s, including 11s to recover and verify
the addon. The full build's earlier TS run passed 218/219 groups; its remaining
TUI minute-boundary fixture was corrected without changing product code before
the successful complete rerun. Earlier run failures and their fixes are recorded
in the removal report alongside timings and hashes.

Final recovered executable:
`dist/actions/42807753137/artifact/builds/macos-intel-20261110T113211Z/extracted/omp`.
The archive is 116,129,219 bytes and the executable is 227,887,216 bytes, 6.17%
and 6.24% smaller than the pre-removal baseline, respectively.

The historical Sharpshooter-only removal was verified with:

```sh
bun check
bun test \
  packages/coding-agent/test/settings-manager.test.ts \
  packages/coding-agent/test/advisor-memory.test.ts \
  packages/coding-agent/test/agent-session-memory-backend.test.ts \
  packages/coding-agent/test/memory-backend-resolve.test.ts \
  packages/coding-agent/test/session-manager/build-context.test.ts \
  packages/coding-agent/test/session-manager/signature-persistence.test.ts
```

At that stage these covered old nested/dotted settings, preservation of stored decisions,
absence of automatic decision injection in primary/advisor prompts, surviving
memory lifecycle boundaries, session replay and compaction. There were 238
passing tests, zero failures and 910 assertions. No Rust sources changed in this
step, so the completed `bun check` runs skipped Rust lint under upstream policy;
the native addon was separately compiled as part of the binary build.

Build timings, source revisions and artifact hashes are recorded in
[the first build report](docs/slim-build-2026-11-10.md). The artifacts are Linux
x64 builds using the host's `modern` native addon (AVX2); they are not a
cross-platform or older-x64 release. The separate macOS artifact and local
verification are recorded in [the Intel Mac report](docs/slim-macos-build-2026-11-10.md).

## Intel macOS through GitHub Actions

The user chose public visibility to use free standard GitHub-hosted runners.
The initial private run `42750509166` was cancelled, and repository visibility
was switched to public while preserving its address and commits. The job
requires `github.event.repository.private == false` to prevent private runs.
According to [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
Intel macOS has 4 CPUs and 14 GB RAM for both public and private repositories;
Linux standard runners increase from 2 CPUs / 8 GB privately to
4 CPUs / 16 GB publicly. Standard public runners are free to use.

The manual workflow is `.github/workflows/slim-macos-intel.yml`. Upstream
workflows are archived in `.github/upstream-workflows/`, outside GitHub's
workflow discovery directory. Repository Actions can be enabled for this build
without activating upstream release or cache-warming jobs.

As verified on 2026-11-10, GitHub still provides Intel macOS runners through
`macos-15-intel` and `macos-26-intel`. `macos-latest` is arm64, and macOS 14
runners have retired. See the [official runner images](https://github.com/actions/runner-images)
and [macOS 15 image contents](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md).

This workflow selects `macos-15-intel`, Xcode 16.4 / SDK 15.5, and deployment
target 15.0 for the local Intel Mac running macOS 15.7.5. Bun remains 1.4.4;
Rust uses `rust-toolchain.toml`, with four parallel Cargo jobs on the four-core
runner. It builds the native addon and CLI, checks the
Mach-O architecture and ad-hoc signature, rejects Homebrew/runner-specific
dynamic library paths, runs the worker smoke test, checks TypeScript, and runs
the complete retained TypeScript CI suite in bounded subprocess groups. Rust intermediates and dependency
downloads are cached; cache saving also runs after validation failures. Runs
time out at 120 minutes; verified archives and the separately downloadable
native addon are retained for 7 days. Compilation or binary-verification
failures also preserve partial binary/addon files for 2 days. Generated native
bindings are uploaded for comparison with the committed files. No provider
credentials are required.

[Run 42763829793](https://github.com/NexusKMT/omp-slim/actions/runs/42763829793)
passed from the earlier source `4cf083db60ff87624b79d960fdedfd6713fea329`. It completed in
32m11s including cache restoration, 22m27s of Cargo compilation, CLI packaging,
worker smoke, TypeScript checks and 238 regression tests (0 failures).
The archive and binary SHA-256 checks passed after download. The extracted CLI
also passed version/help, worker smoke, shell pipelines, file roundtrip and
exit-status checks on the local Intel Core m3-8100Y / macOS 15.7.5.
This is a `darwin-x64-modern` build with an `x86-64-v3` native addon, validated
for the current AVX2-capable host and macOS 15+.

Recovered artifact directory:
`dist/actions/42763829793/artifact/builds/macos-intel-20261110T054738Z/`.
The extracted executable is `extracted/omp` under that directory. Full logs,
hashes, cold/cache build timings and the validation-script fixes are in
[the Intel Mac report](docs/slim-macos-build-2026-11-10.md).

```sh
gh workflow run slim-macos-intel.yml --repo NexusKMT/omp-slim --ref main
gh run list --repo NexusKMT/omp-slim --workflow slim-macos-intel.yml
gh run view RUN_ID --repo NexusKMT/omp-slim
gh run watch RUN_ID --repo NexusKMT/omp-slim
gh run view RUN_ID --repo NexusKMT/omp-slim --log-failed
gh run view RUN_ID --repo NexusKMT/omp-slim --log > actions.log
rg -n -i 'error|failed|exception' actions.log
gh run download RUN_ID --repo NexusKMT/omp-slim --dir dist/actions/RUN_ID
```

Use Chrome DevTools MCP to inspect live Actions logs. `gh` supports status
checks and recovery of completed logs/artifacts: `watch` reports job/step
progress, but full job logs may remain unavailable until the job finishes.
Use `run view --json status,jobs` for supporting status checks.

For a TS-only change with an available Intel addon, run the separate manual
test workflow. The supplied build must have a successful native build step;
the workflow compares native build inputs and verifies artifact digests,
bindings and exports before running the same complete TS checks/tests:

```sh
gh workflow run slim-macos-tests.yml --repo NexusKMT/omp-slim --ref main \
  -f build_run_id=42807753137
```

Use a new full build if native inputs changed or the seven-day artifacts have
expired. The test workflow records both the current source and native source.
It also rebuilds and verifies the current standalone CLI, then uploads a separate archive with both application and native source provenance. Only the generated standalone Rust RPC SDK is excluded from native-input matching; native crate sources and dependencies remain guarded.

Update this downstream through the pinned repository and its build artifacts.
The `omp update` command, startup version check, background updater and update
setup scene have been removed. Old `update.*` and `startup.checkUpdate` settings
are ignored on load; no user files are deleted. Plugin marketplace updates remain
independent. Upstream installers and package-manager channels do not distribute
this fork.

Use the resulting `omp-darwin-x64.tar.gz`, verify `ARCHIVE-SHA256SUMS`, extract it,
then verify `SHA256SUMS` with `shasum -a 256 -c`. Test the extracted binary from
its artifact directory before installing it. Use an isolated
`PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` for local smoke tests; the latter also
isolates shared runtime/log directories. The build uses ad-hoc signing and does
not perform Apple notarization. Provider authentication is outside these tests.
