# OMP Slim

Private downstream: https://github.com/NexusKMT/omp-slim

The source baseline is upstream v18.18.3, commit
`21f1188cf88b2f534c092181968cd5a4d1a9c296`. The original MIT license and
third-party notices are retained. `upstream` points to can1357/oh-my-pi;
`origin` points to this private repository.

The requested scope is removal of built-in browser automation, host desktop
control, speech/live audio, and automatic long-term memory. Session storage,
resume/history, context compaction, file editing, shell execution, subagents,
ordinary HTTP search, MCP and manually maintained instructions remain core.

Implementation order: build baseline, memory, voice, desktop, browser, then
dependency and packaging cleanup. A disabled setting alone is not evidence that
a component has been removed from the product. Track the actual state below.

| Stage | State |
| --- | --- |
| Private repository and pinned upstream baseline | Established |
| Repeatable Codespace bootstrap/build/artifact procedure | Added; first run pending |
| Browser, desktop, speech and memory removal | Pending |

Browser removal must account for Chromium-backed PDF page screenshots, web-search
fallbacks and cookie-capture login. Preserve PDF text extraction and HTTP search;
remove browser-dependent fallbacks explicitly. Standard OAuth callbacks and API
keys remain supported. Long-term memory removal must not erase stored sessions.
`ttsr` means Time-Traveling Stream Rules, and Rust `memory.rs` manages the native
heap; neither belongs to the memory/speech removal scope.

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

The Codespace bootstrap installs Bun 1.4.4 and the toolchain pinned by
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

## Validation

The build script checks the produced binary's version/help and worker smoke test.
This does not replace feature regression tests. Follow upstream `AGENTS.md`:
`bun check`, targeted Bun tests, and `bun run test:rs` for Rust changes. Report
baseline failures separately from regressions. Never treat a passing build as
proof of real provider authentication or of completed feature removal.
