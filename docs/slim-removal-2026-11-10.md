# Browser, desktop, speech and automatic memory removal

This report covers the removal integrated after `c3b3c3dd12`, the documented
Sharpshooter-only baseline. The downstream is the public repository
`NexusKMT/omp-slim`, based on upstream v18.18.3. Earlier successful Linux and
Intel Mac builds do not establish that this larger removal builds correctly.

## Product boundary

| Removed | Retained behavior |
| --- | --- |
| Built-in browser tool/preludes, Chromium/Puppeteer, Chrome installer, tab workers, relay backend and browser extension | HTTP search/fetch, normal system URL opening, external MCP, Tern terminal `/fork` |
| Browser PDF page screenshots, browser search fallbacks, cookie-capture sign-in | Native PDF text/page extraction including archives; external OCR guidance for scans; normal OAuth/API-key and email OTP/TOTP |
| Native desktop capture, accessibility, application/window control and input on macOS/Linux/Windows; `computer` worker/tool/prelude/command | Clipboard, shell/PTY, user-wait coordination, image processing, power management, ordinary terminal recording |
| Microphone capture, dictation, TTS, live voice, speech setup/downloaders, `say`, `tts`, `/live`, voice extension/RPC/ACP surfaces and `pi-voice` | Text input, paste/undo/Vim, terminal bell, ordinary model authentication and generic provider/catalog protocol types |
| Local summaries, Hindsight, Mnemopi, Sharpshooter residue, automatic learning/extraction/injection, memory tools/commands/URL scheme, `packages/mnemopi`, dedicated native vector kernels | Session storage/history/resume/fork, context compaction, explicit `manage_skill`, manual AGENTS/SKILL files and skill discovery |

Codex attestation was moved unchanged from `live/attestation.ts` to
`config/codex-attestation.ts`; ordinary Codex requests still need it.
Larger local tiny models remain available for completion/judgment. Their
former memory-specific grouping was renamed to describe those retained uses.
Generic model/provider computer-call and audio wire types remain for SDK and
history compatibility. `ttsr` and native heap `memory.rs` are unrelated and remain.

Old browser, desktop and memory configuration keys are retired during normal
configuration migration. Existing user data files are not deleted. Old speech
keys remain inert and cannot restore a deleted tool. Manual skill discovery
continues to read previously managed skills.

## Source and dependency changes

Four isolated worktrees handled the feature removals. The user capped
concurrency at five agents including the coordinator; existing workers were
reused for integration reviews and could not spawn further workers.

The integrated feature commits and follow-ups, before the final lock/report
commit, change 1,021 files with 1,803 additions and 238,929 deletions relative to
`c3b3c3dd12`. These counts include implementation, dedicated tests, generated
schemas and documentation; they are not a binary-size measurement.

| Lockfile metric | Before | After |
| --- | ---: | ---: |
| Cargo package entries | 979 | 799 |
| Bun package entries | 462 | 396 |
| Bun workspace entries, including the root | 18 | 16 |

`cargo update --workspace` removed unused entries while preserving all retained
package versions: 180 removals and no additions. Bun resolution likewise added
no package entries. `bun run gen:nix` regenerated the Nix dependency expression,
and the frozen Bun installation check passed. The Bazel derived lock must also
match the final Cargo graph; its generation status is recorded below.

Native third-party notices were conservatively pruned only for crate names
entirely absent from the final lock. This removed 224 records and 88 empty
license blocks, preserving 779 records and every corresponding license text
byte. Removed Opus and inferno notices were also dropped; retained obligations
such as uluru, PCRE2 and vendored sources remain. An independent multiset
comparison checked each retained record and license-body SHA-256. Existing
upstream version drift in notices, including libc/jiff/zip, was preserved;
this is not a full cargo-about regeneration or a license coverage audit.

## Validation

The merged tree passed the full `bun run check:ts` command: lint, formatting and
all workspace type checks. Fourteen existing lint warnings remain; there were
no lint or type errors. Rust formatting passed with the pinned
`nightly-2026-11-08` formatter. Workflow syntax passed actionlint 1.7.12.

Feature workers exercised migration and stored-data preservation, session
resume/fork/compaction, manual skills, HTTP/PDF/MCP/Tern behavior, clipboard,
TUI editing, RPC schemas and the affected Python SDK. Their focused runs used
the baseline native addon for retained functionality; those runs cannot prove
that the rebuilt addon has removed all retired symbols.

Some combined local test invocations exposed shared authentication/fixture
state failures that disappeared in isolation. They must be checked with the
complete retained suite in a clean CI environment; isolated passes are not
reported as a full-suite pass.

Two manual workflows validate the final source on public runners:

- `slim-macos-intel.yml`: macOS 15 Intel, Xcode 16.4, deployment target 15.0;
  rebuild the native addon and standalone CLI, verify Mach-O load paths and
  signing, run worker smoke, TypeScript checks and the complete TypeScript CI
  suite with concurrency two.
- `slim-rust-checks.yml`: Ubuntu 24.04; `bun run check:rs` and
  `bun run test:rs`, including nextest and the wrapper's doctest pass.

Both jobs require a public repository. Native compilation runs in Actions;
the local Intel Mac only prepares metadata, checks TypeScript/formatting and
validates recovered artifacts. The Codespace remains stopped.

Final workflow runs, rebuilt artifact sizes/hashes and local verification are
pending. They will be recorded here after completion.
