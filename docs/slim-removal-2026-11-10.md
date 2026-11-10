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

The integrated source at `d7f1646f90182a27353b8c38455e2d1c4a892f15`
changes 1,051 files with 3,988 additions and 245,196 deletions relative to
`c3b3c3dd12`, a net reduction of 241,208 lines. These counts include
implementation, dedicated tests, generated schemas, lockfiles and
documentation; they are not a binary-size measurement.

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

The final Rust workflow has passed. The first rebuilt Mac artifact also passed
local execution checks, but its complete TypeScript suite exposed remaining
integration and fixture defects. A corrected full Mac run is still required.

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

[Rust run 42788678239](https://github.com/NexusKMT/omp-slim/actions/runs/42788678239)
passed in 16m29s. Formatting/Clippy took 1m15s, test compilation 4m26s, and
nextest ran 6,364 tests in 421.128s: all passed, with 16 skipped. The separate
doctest pass also passed all six runnable examples (28 ignored). The source
record and full Actions log were recovered under
`dist/actions/42788678239/`.

The Intel Mac rebuild is run `42786339677`, from
`ee212e46ba0734b4f4fefaa9518cfbc377bb0f6f`, including the packaged-viewer fix.
Native compilation, standalone packaging, the retired-export gate, worker smoke
and the full TypeScript check passed. The full retained TypeScript suite ran
219 commands in 22m17s: 210 passed and nine failed. The whole job took 52m42s.
Native compilation took 23m39s (1,424s including binding generation), and CLI
packaging took 60s. This did not improve on the baseline's 22m27s native compile;
the different dependency graph and cache state prevent a controlled timing
comparison.

The Mac test failures identified a real advisor recorder transition regression
after removing the memory reset await, stale memory-role expectations and an
essential-tool registration, a settings test tied to the old tab order, shell
fixtures assuming completion within 100ms, and ACP/SDK lifecycle issues. All
nine failing groups have corresponding fixes with focused validation; the
corrected source is `6647801a3e`. NSSpellServer also
timed out on the hosted runner. Its platform check remains enabled; one
explicit AppleSpell service integration is skipped only by that workflow.
The new native addon passed the real spelling integration on the local Mac,
including UTF-16 ranges and filtering whole-string orthography results.

The first trimmed archive and binary were recovered and verified locally:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `omp-darwin-x64.tar.gz` | 116,107,286 | `7760989b10419d4860f868cf8bf92353bf4afdb106c0448dc3a0e7ebbbfdff80` |
| Extracted `omp` | 227,854,192 | `26cc00d7d9350040a22c2223cb31159cc6848bf339f0c497e5a3317ccac41659` |
| Native addon | 106,469,112 | `69d6286d39197ff576425a4cce874fc95c65b4e056cdaf90ac1758954f72564f` |

The archive is 6.19% smaller than the baseline's 123,766,511 bytes; the binary
is 6.25% smaller than 243,045,232 bytes. Generated native bindings exactly
matched the committed files, and both source-status records were clean.
Checksums, Mach-O architecture, ad-hoc signature, version/help, worker smoke,
shell pipelines, file roundtrip and exit-status preservation passed on the
Intel Core m3-8100Y / macOS 15.7.5 host. The compiled CLI exported a real test
session; its HTML rendered the expected message in an isolated Chrome context
without console errors. The viewer was inline, with only the existing fixed
marked/highlight resources external. Evidence is under
`dist/actions/42786339677/`; this intermediate binary predates the subsequent
session lifecycle fixes and is not the final validated source.

The advisor fix keeps recorder feeds detached until the existing mode
transition completes, preserving old-session costs while excluding late
events from the new branch. The ACP fix checks the captured prompt identity
and settled state after asynchronous waits, so an old end handler cannot
drain late results or finish a newer request. Its deterministic regression
fails against the earlier implementation and passes after the fix. The SDK
timeout fixture now tests recovery in a separate lifecycle emission with the
normal budget, using a fake timer only for the intentionally stalled call.
Shell-state fixtures await the individual job's final result and use an
explicit release marker to establish overlap. The complete affected ACP,
async-delivery and SDK files passed 190 tests with 838 assertions in isolated
processes/configuration. The merged workspace also passed `check:ts` locally
with the newly built native addon.

The second Mac workflow is
[run 42797373269](https://github.com/NexusKMT/omp-slim/actions/runs/42797373269),
from `6647801a3ecfb36d046ebc0a07363e7277d5c15e`. Compilation and binary
verification passed in 27m56s, including 26m03s of native compilation despite
restoring a 1.35 GB cache. TypeScript checks passed. The job finished in 60m42s;
the full TS suite ran for 24m59s with 217 of 219 command groups passing. All
nine groups that failed in the previous run passed. The new failures were the
native PTY argument test and a PlusCal AST-search test returning no matches.
The full Actions log was recovered under `dist/actions/42797373269/`.
The full suite exposed a
previously passing native PTY test intermittently receiving no complete JSON
output from a fast-exiting child.

The PTY implementation and original test were unchanged from the baseline.
Concurrent reproduction confirmed output loss even with awaited or synchronous
child writes, so changing the fixture's write API would not fix the issue.
A minimal system-PTY probe showed that macOS can discard unread output when
the last slave descriptor closes. The existing `pi-shell` zpty implementation
already accounts for that behavior. The native PTY fix now retains that
descriptor until the reader accepts the available bytes. A bounded progress
notification wakes the wait; cancellation, timeout, reader disconnect and
failed readiness queries can all terminate it. The existing JS/backpressure
drain still delivers bytes already read. Three deterministic Unix regressions
and a concurrent fast-exit JS regression cover the change. Independent review
found no blocking issue; a rebuilt Mac verification remains necessary.

The grammar failure was reproduced with an empty cache and an unavailable
download endpoint. Both the AST search alias test and the related `.tla`
editing test now parse the pinned official grammar in isolated child
processes. Its compressed fixture is 123,099 bytes, accompanied by the MIT
license and provenance; decompressed size/hash must match the native
manifest. The same ten-file CI group passed 275 tests / 1,145 assertions
offline, preserving real matching, preview and file-write checks.

[Rust run 42806432208](https://github.com/NexusKMT/omp-slim/actions/runs/42806432208)
passed from `159a36becd6363a99d5b7ee9c3da9d77af20107f` in 13m05s.
Formatting/Clippy passed; compilation took 3m30s, and all 6,367 runnable tests
passed in 403.875s, with 16 skipped. All six runnable doctests passed, with
28 ignored. The subsequent grammar-fixture commit changes no Rust inputs.
The full log is recovered under `dist/actions/42806432208/`.

Mac run `42806441116` was cancelled during setup to include the grammar-test
fix before compiling. The final Mac run is
[42807753137](https://github.com/NexusKMT/omp-slim/actions/runs/42807753137),
from `d7f1646f90182a27353b8c38455e2d1c4a892f15`. It also runs
`bun run test:rs:pty` on macOS with the native `ci` profile, then the complete
TypeScript suite. Results and local artifact verification are pending.

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
