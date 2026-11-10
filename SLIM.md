# OMP Slim

Public downstream: https://github.com/NexusKMT/omp-slim

The source baseline is upstream v18.18.3, commit
`21f1188cf88b2f534c092181968cd5a4d1a9c296`. The original MIT license and
third-party notices are retained. `upstream` points to can1357/oh-my-pi;
`origin` points to this downstream repository.

The requested scope is removal of built-in browser automation, host desktop
control, speech/live audio, and automatic long-term memory. Session storage,
resume/history, context compaction, file editing, shell execution, subagents,
ordinary HTTP search, MCP and manually maintained instructions remain core.

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
| Other memory backends, browser, desktop and speech removal | Source, registration, workers, UI, dedicated tests/docs and native backends removed; rebuilt addon export checks passed; full Rust validation passed; Mac integration fixes are being verified |
| Dependency cleanup | Cargo packages 979 → 799, Bun packages 462 → 396, Bazel repositories 962 → 783; no new package versions; two dedicated workspaces removed |
| Intel macOS Actions build | Trimmed run `42786339677` compiled and passed local binary verification; its full TS suite exposed remaining integration/fixture failures, so a corrected full run is required |

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
`docs/natives-build-release-debugging.md`, `scripts/bazel-natives.ts`,
`packages/natives/scripts/build-bindings.ts`, and
`packages/coding-agent/scripts/build-binary.ts`.

The Codespace uses `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` with
the `vscode` user and the official `sshd` devcontainer feature. The bootstrap
installs Bun 1.4.4 and the toolchain pinned by
`rust-toolchain.toml`, plus Linux native build tools and frozen JS dependencies.
The host native build uses Cargo/N-API. Cross-platform release addons use Bazel;
a Linux host binary is not a macOS deliverable.

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

The build script checks the produced binary's version/help and worker smoke test.
This does not replace feature regression tests. Follow upstream `AGENTS.md`:
`bun check`, targeted Bun tests, and `bun run test:rs` for Rust changes. Report
baseline failures separately from regressions. Never treat a passing build as
proof of real provider authentication or of completed feature removal.

The fully trimmed tree uses two manual public workflows: `slim-macos-intel.yml`
rebuilds and tests the macOS artifact and retained TypeScript workspace;
`slim-rust-checks.yml` runs Rust formatting/lint plus nextest and doctests on
Ubuntu 24.04. Both are gated on public visibility. The Rust job uses the
repository's `check:rs` / `test:rs` wrappers and does not need a Codespace.

[Rust run 42806432208](https://github.com/NexusKMT/omp-slim/actions/runs/42806432208)
passed formatting, Clippy, all 6,367 runnable nextest tests (16 skipped), and
all six runnable doctests (28 ignored). The trimmed Mac binary from
`42786339677` passed local checksums, version/help, worker smoke, shell/file
behavior and compiled HTML session export. Its newly built addon also passed
the actual AppleSpell service test locally; the hosted Mac workflow explicitly
skips that one service integration because NSSpellServer times out there.
The first full Mac test suite was not green: 210 of 219 command groups passed.
The second run passed 217 groups and exposed a macOS PTY output race and a
grammar-download-dependent test. Both have been corrected. Final Mac run
`42807753137` includes native PTY regressions on macOS, all TS groups and
separate native-addon artifacts. See the removal report for validation status.

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
Linux/Windows standard runners increase from 2 CPUs / 8 GB privately to
4 CPUs / 16 GB publicly. Standard public runners are free to use.

The manual workflow is `.github/workflows/slim-macos-intel.yml`. Upstream
workflows are archived in `.github/upstream-workflows/`, outside GitHub's
workflow discovery directory. Repository Actions can be enabled for this build
without activating upstream release, Nix or cache-warming jobs.

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
gh run download RUN_ID --repo NexusKMT/omp-slim --dir dist/actions/RUN_ID
```

Use the resulting `omp-darwin-x64.tar.gz`, verify `ARCHIVE-SHA256SUMS`, extract it,
then verify `SHA256SUMS` with `shasum -a 256 -c`. Test the extracted binary from
its artifact directory before installing it. Use an isolated
`PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` for local smoke tests; the latter also
isolates shared runtime/log directories. The build uses ad-hoc signing and does
not perform Apple notarization. Provider authentication is outside these tests.
