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
match the final Cargo graph. Both `gen:bazel-lock` and a subsequent `--check`
passed, including a check after removing the temporary download mirror used
to work around slow downloads. The generated repository count fell from 962
to 783, with 179 removals and no additions; the lock shrank from 4,009,531 to
3,279,903 bytes. A stale `ring` annotation was removed. The resulting lock
contains no local paths or mirror URLs.

Native third-party notices were conservatively pruned only for crate names
entirely absent from the final lock. This removed 224 records and 88 empty
license blocks, preserving 779 records and every corresponding license text
byte. Removed Opus and inferno notices were also dropped; retained obligations
such as uluru, PCRE2 and vendored sources remain. An independent multiset
comparison checked each retained record and license-body SHA-256. Existing
upstream version drift in notices, including libc/jiff/zip, was preserved;
this is not a full cargo-about regeneration or a license coverage audit.

The changed HTML viewer is now embedded in compiled and npm CLI builds and
included as a packaged text asset for SDK imports. Exports inline that viewer
instead of requesting the downstream hash from upstream's CDN. The existing
fixed marked/highlight resources remain external. Forty-seven relevant tests
passed, including a real compiled probe, npm packing, SDK/source parity and
execution of the generated inline viewer. This adds roughly 769 KiB to each
exported HTML document.

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

One combined SDK suite exposed shared settings contamination: a shell test
initialized global settings, and a shared ModelRegistry without explicit
settings then adopted the user's disabled-provider list. The fixture now uses
isolated settings, in-memory authentication and a temporary model path.
Reproduction with a synthetic globally disabled OpenAI provider passed all
57 tests / 253 assertions after the fix, with two loopback requests and zero
external network attempts. This does not replace the full retained CI suite.

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

The first integrated runs, Mac `42783413828` and Rust `42783420636`, stopped
during dependency installation because the export viewer manifest had not
been regenerated after removing feature-specific renderers. Neither reached
native compilation. The viewer manifest was regenerated, and a frozen install
including the prepare script then passed locally. Cache saving now requires
successful toolchain/dependency setup, preventing failed bootstraps from
occupying the final build-cache key. Rust was restarted as `42784508716` from
`a3130cafd71f769037e8f2915dd1bd077a7f8b53`.

Rust run `42784508716` passed formatting/Clippy (5m50s for the step), compiled
tests in 11m51s and ran 6,364 tests in 427.232s: 6,363 passed, one failed,
16 skipped. The failing unchanged shell test sent Ctrl-D immediately after
PTY creation, while canonical mode could still consume it as VEOF. It now
uses the existing `wait_raw` before sending the same key and checking the
same exit status/deadline. Production shell behavior was unchanged. Rust was
restarted as `42788678239` from `d76c2adad081b90c8b86202ac6e93cfeddbf7707`.

The Intel Mac rebuild is run `42786339677`, from
`ee212e46ba0734b4f4fefaa9518cfbc377bb0f6f`, including the packaged-viewer fix.

## Maintaining the downstream

The upstream baseline remains pinned. Integrate selected upstream fixes and
review shared registration/lifecycle files carefully: CLI dispatch, SDK,
AgentSession, settings/tool registries, native exports and build manifests were
touched by several removals. A future upstream merge can otherwise restore a
retired capability or a dependency without recreating its whole directory.

Dependency changes require Bun/Cargo lock updates and regeneration of both
Nix and Bazel metadata. RPC changes require `gen:rpc`; export renderer changes
require `gen:export-viewer --write` and the packaged-export tests. The native
build now checks the actual addon for retired exports while checking that
clipboard, shell and PDF entry points remain present.

The retained AST/grammar, Git/Jujutsu, PDF/image and local inference components
still require a substantial Rust toolchain. Source deletion and fewer locked
packages do not imply a proportionate reduction in compilation time. Public
manual Actions keep validation under explicit control; cache and artifact
timings above provide the measured basis for future maintenance estimates.
