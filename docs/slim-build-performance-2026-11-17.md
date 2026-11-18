# Native build performance — 2026-11-17

The `ci` profile now keeps O3 and disables LTO. A warm addon-only compile
fell from 10m 03s to 2m 46s (72.5% shorter), and the isolated PTY regression
command takes 8s instead of the preceding 19m 14s. All three comparison jobs
and the complete Linux Rust validation passed.

The development goal is faster feedback after editing code. The source CLI and
focused crate commands now provide that path; the local measurements below are
separate from the remote full-build comparison.

## Local development feedback

The working checkout now loads the verified O3/no-LTO native addon from run
`43947005367`, source `91e59623f58a23792c97c73f08d34d0d1acb08cd`.
Its SHA-256 is
`a99244e40901e09b3659befa708ae4c88b2cb10350dcd4e5c98f1c8c66efe327`.
The previous local addon still exposed removed APIs despite having the same
package version. It was backed up, replaced, and checked with
`scripts/slim/verify-native.ts`. The generated declarations were recovered with
the addon. Ordinary TypeScript edits can now use `bun run dev`, restarting the
source process after each edit, without compiling or packaging Rust.

The Rust task wrapper previously ignored extra arguments. It now accepts
`--package` / `-p` for `check:rs`, `lint:rs` and `test:rs`, plus `-E` /
`--filter-expr` for focused nextest runs. An explicit package runs regardless of
the branch-diff gate. Formatting, Clippy and doctests are restricted to the
selected packages; nextest filters leave those doctests enabled. Unknown
options and a test filter without a package fail before Cargo starts.

These are wall times measured on the local Intel Mac, including the command
wrapper. The source CLI used isolated configuration directories and made no
model requests. Rust commands used two build jobs and the same initially empty
`CARGO_TARGET_DIR=/tmp/omp-slim-rust-feedback-501`; only `pi-pty` and its small
dependency graph were compiled locally.

| Operation | Wall time | Result |
| --- | ---: | --- |
| Source CLI `--version` | 0.516s | Passed |
| Source CLI `--help` | 0.551s | Passed |
| Source CLI `--smoke-test` | 6.977s | Worker and service responses passed |
| Four native PTY binding cases | 1.860s | 4 passed |
| `bun run check:rs --package pi-pty` | 5.871s | Formatting and Clippy passed |
| `bun run test:rs --package pi-pty` | 11.029s | First test build, 7 tests passed, doctest pass completed |
| `bun run test:rs --package pi-pty -E 'test(cancel)'` | 2.966s | Cached build, 2 tests passed, doctest pass completed |

An additional edit/run/restore probe verified that changed source is actually
observed. A temporary CLI help marker appeared on the next source invocation
in 0.279s and disappeared after restoration in 0.271s. In `pi-pty`, temporarily
dropping the cancellation callback instead of calling it caused the existing
cancellation test to fail in 3.282s, including recompilation. Restoring the
implementation recompiled the crate and passed both cancellation tests in
3.766s. Both source files were restored byte for byte; the probe changes are
not part of the implementation. Logs and source hashes are recorded alongside
`edit-feedback-timings.json`.

The 2.966s cached filtered run had no intervening source edit; the edit probe
above did. Neither measures rebuilding the full addon after a Rust change.
The complete native graph still requires a remote build, and a new addon is
needed to observe native changes in the CLI. `--help` timing is also not an
interactive-session or model-response latency measurement.

Eight wrapper regression tests, script type checking, focused script lint and
formatting, and native-package type checking passed. Raw command logs, timing
JSON and the addon installation record are in
`dist/validation/dev-loop-2026-11-17/`. See
[`SLIM.md`](../SLIM.md#development-feedback) for the everyday commands.

## Implemented changes

The seven output-drain regression tests now compile `pi-pty`, a small crate
containing the implementation also called by the N-API PTY session. The drain
function body is unchanged. Its generic queue payload removes the dependency
on the addon's `ReaderEvent` type; cancellation, EOF, slow callbacks and
backpressure behavior remain covered by the original tests.

`test:rs:pty` now selects `pi-pty` and passes an explicit Cargo target, matching
napi's `CARGO_BUILD_TARGET` or the active Rust toolchain's host triple. Before
this change napi built under `<target>/<triple>/ci` while nextest used
`<target>/ci`. Matching the directory alone would still require a separate
large test executable, so extracting the tested implementation is the main
fix. Cargo's unit graph drops from 716 units for the implicit-target native
test executable to 8 for the explicit-target PTY test executable. Feature
unification can still cause some small dependencies to rebuild.

The normal macOS workflow also runs the existing `PtySession` integration
cases against the fresh addon: argv handling, process-start notification,
slow-consumer backpressure and detached-workload timeout. These validate the
binding and operating-system behavior in addition to the extracted queue
logic. The build message now prints the selected Cargo profile instead of
always saying `local`.

## Controlled comparison

- Measured source: `91e59623f58a23792c97c73f08d34d0d1acb08cd`.
- [macOS comparison](https://github.com/NexusKMT/omp-slim/actions/runs/43947005367).
- [Rust validation after lint corrections](https://github.com/NexusKMT/omp-slim/actions/runs/43948335321).
- Follow-up `5cf221912c` removes an unused import and adds a closure semicolon;
  neither changes runtime behavior. The first Rust run caught these lint
  errors before its tests ran.

All comparison jobs select macOS 15 Intel, Xcode 16.4, Bun 1.4.4, the pinned
Rust toolchain, four Cargo jobs, the `ci` profile and
`RUSTFLAGS=-C target-cpu=x86-64-v3`. WASM grammars are disabled in all modes.

| Mode | Workspace optimization | External dependency optimization | LTO |
| --- | --- | --- | --- |
| o3-thin | 3 | 3 | thin |
| o3-no-lto | 3 | 3 | off |
| o2-no-lto | 2 | 3 | off |

All restore this same immutable cache:

`slim-macos15-intel-xcode16.4-ci-v1-8f312bb89b577fc52697d8941407e643134b8dca88cc5d9d7664cd00d67ec3be`

The cache contains the earlier ThinLTO/WASM-enabled graph. Changing LTO
invalidates cached dependency units, so the first build measures migration
cost rather than steady-state work. Each job then touches only
`crates/pi-natives/src/pty.rs` and rebuilds the addon, with its dependencies
already compiled. Cargo HTML timing reports and wall-clock timers capture
both builds. Compilation units can overlap; their durations must not be
summed as wall time.

## Validation status

Local full `check:ts`, all five Rust-wrapper regression tests, Cargo formatting,
and workflow YAML/shell parsing passed. Remote Rust formatting and Clippy
passed at `5cf221912c4763a8a1876c20bab9f90b1fb8cd35`. All 6,218 nextest tests
passed (52 skipped), as did 6 doctests (27 ignored). Test compilation took
3m 30s and nextest execution took 303.452s. All three macOS jobs passed worker
smoke, 15 grammar tests, 7 queue tests and 6 binding tests. Four binding cases
exercise PTY; the original `pty` filter
also matched two `empty` cases. The final workflow uses `\bpty\b` and the
recovered addon verification selects exactly those four cases.

## Measured results

| Measurement | O3 ThinLTO | O3, LTO off (selected) | Workspace O2, LTO off |
| --- | ---: | ---: | ---: |
| First Cargo native compilation | 27m 09s | 41m 31s | 36m 35s |
| First native build including bindings | 27m 21s | 41m 36s | 36m 42s |
| CLI packaging | 54s | 78s | 63s |
| Addon-only Cargo rebuild | 10m 03s | **2m 46s** | 2m 00s |
| Addon-only rebuild including bindings | 10m 06s | **2m 51s** | 2m 04s |
| PTY test compilation | 9.12s | **3.23s** | 2.37s |
| Seven PTY tests | 2.860s | 3.004s | 2.992s |
| Complete Rust PTY command | 13s | **8s** | 7s |
| Addon size | 94,403,344 bytes | 93,884,000 bytes | 93,151,904 bytes |
| CLI size | 194,367,856 bytes | 193,723,888 bytes | 193,509,232 bytes |
| Whole job including comparison rebuild and artifact upload | 44m 19s | 52m 10s | 45m 16s |

Every runner reported Intel i7-8700B, four exposed logical CPUs and 14 GiB RAM.
The first build emitted 57 Cargo timing units with ThinLTO versus 763 with LTO
off: the old cache did not match the new optimization settings. These first
build times therefore do not demonstrate a clean-build speedup. Cache restore
alone took 233s, 252s and 210s respectively. The extra addon rebuild exists
only in the optimization experiment, not in the normal build job.

Each second build emitted exactly one timing unit, `pi-natives`. Its durations
were 602.17s, 164.58s and 119.12s respectively. This provides direct evidence for
faster iteration after dependencies are available, though separate hosted
runners and a single sample per mode limit precision. Cargo does not split
this final unit into separate LLVM and linker durations; it would be incorrect
to label its entire duration as linking.

The first O3/no-LTO dependency path still spends substantial time in
`pi-builtins` (621.35s) and `pi-shell` (532.32s), plus shared libraries such as
`jj-lib` (386.72s). Those unit durations overlap. The patch removes repeated
large compilation for PTY tests and reduces addon rebuild cost; it does not
make a fresh native dependency build instantaneous.

The prior default/no-WASM run at `ce08acb110` spent 19m 02s compiling the large
PTY test executable and 19m 14s in the entire PTY command. With the new tiny
crate, even the unchanged ThinLTO configuration compiles it in 9.12s and finishes
the command in 13s. With the selected configuration the command takes 8s.

## Default and limits

Only `ci` changes to `lto = "off"`; O3, 16 codegen units, unwind handling and
stripping remain. Cargo's resolved graph without environment overrides matches
the measured O3/no-LTO overrides. `release` and `local` keep their existing
optimization settings. O2 remains a comparison option: its additional compile
saving does not by itself justify reducing workspace optimization.

The existing N-API tokenizer probe was run against each recovered addon in
separate processes on the same Intel Mac, with 33 encoding/corpus combinations,
one second per case, and two rounds per addon. Every token count matched across
all modes. O3/no-LTO throughput averaged across the two rounds had a geometric
mean ratio of 1.33 relative to ThinLTO; O2/no-LTO was 0.97. However, individual
round ratios varied substantially (O3/no-LTO 1.56 and 1.17; O2/no-LTO 1.14 and
0.86), so these data do not establish a runtime speedup or performance parity
for the full application. The probe source, raw samples and summary are saved
with the build evidence. No local Rust compilation was used.

The source containing the two lint corrections passed the complete Rust gate.
The comparison artifacts use the earlier snapshot; their only Rust difference
from that validated implementation is the removed unused import and closure
semicolon. Later changes select the already-tested CI profile, improve the
build log, narrow the test filter, and document results. The full TypeScript
runtime suite was not rerun for this performance experiment.

All three GitHub artifact ZIP digests were checked, as were the nested CLI
archive and binary checksums. Logs, metrics, Cargo timing reports, unit graphs,
recovered binaries and a provenance manifest are under
`dist/validation/build-perf-2026-11-17/`.
