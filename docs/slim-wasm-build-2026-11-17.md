# AST WASM build comparison — 2026-11-17

Disabling optional AST WASM grammars reduced the native addon by 5.67 MB and
the standalone CLI by 1.75 MB, but did not speed up this build from the existing
WASM-enabled cache. Both configurations built successfully and passed the
worker smoke, grammar regressions and macOS PTY tests.

Measured source: `ce08acb110f3e87d15bed132473706352ade641e`, on
`perf/wasm-build-2026-11-17`. This includes the preceding cleanup snapshot.
The local main working tree contains these implementation changes; this test
branch has not been merged into main.

- [macOS comparison run](https://github.com/NexusKMT/omp-slim/actions/runs/43931958426)
- [Rust validation with WASM disabled](https://github.com/NexusKMT/omp-slim/actions/runs/43932030567)

## Measurement

Both jobs used macOS 15 Intel, Xcode 16.4, Bun 1.4.4, the pinned Rust toolchain,
the `ci` profile (ThinLTO, 16 codegen units), 4 Cargo jobs and
`-C target-cpu=x86-64-v3`. Both reported an Intel i7-8700B, 4 exposed cores and
14 GiB of memory. They ran on separate hosted runners and restored the same
immutable cache:

`slim-macos15-intel-xcode16.4-ci-v1-8f312bb89b577fc52697d8941407e643134b8dca88cc5d9d7664cd00d67ec3be`

| Measurement | WASM enabled | WASM disabled | Change |
| --- | ---: | ---: | ---: |
| Cargo native compilation | 22m 19s | 24m 42s | +2m 23s |
| Native build including bindings/install checks | 22m 30s | 24m 50s | +2m 20s |
| CLI build | 59s | 54s | -5s |
| PTY test target compilation | 13m 11s | 19m 02s | +5m 51s |
| PTY tests themselves | 3.020s | 2.988s | approximately equal |
| Cache restoration | 2m 28s | 4m 48s | +2m 20s |
| Entire job, including setup and artifact upload | 40m 59s | 51m 49s | +10m 50s |
| Native addon | 100,105,512 bytes | 94,436,136 bytes | -5,669,376 bytes (-5.66%) |
| Standalone CLI | 196,118,128 bytes | 194,367,856 bytes | -1,750,272 bytes (-0.89%) |

This measures switching from an existing cache, not clean compilation or a
steady-state warm build. The enabled build reused Wasmtime/Cranelift without
recompiling them. The disabled feature graph invalidated Tree-sitter and
several shared dependencies, including Git-related libraries. The native build
logged 44 package compilations when disabled versus 21 when enabled. The
additional work and hosted-runner variation limit causal conclusions from this
single pair. Cache and setup time are not native compilation time.

The normal/build dependency graph for `x86_64-apple-darwin` dropped from 589 to
554 distinct package/version pairs, or 564 to 531 package names. All 20
Wasmtime/Cranelift package names left that graph. The lockfile still records
optional dependencies so the explicitly enabled configuration remains pinned.

## Cargo timing evidence

The uploaded native build reports contain these compilation-unit durations.
Units overlap, so their durations must not be added as wall time. Cargo does
not separately break down code generation and linking for the final
`pi-natives` unit in these reports.

| Unit | WASM enabled | WASM disabled |
| --- | ---: | ---: |
| `pi-natives` | 785.40s | 673.21s |
| `pi-shell` | 352.64s | 542.49s |
| `pi-builtins` | 289.06s | 516.54s |
| `pi-vcs` | 141.09s | 208.42s |
| `jj-lib` | cached | 368.50s |

The final `pi-natives` unit shortened by 112.19s, but started later: 808.26s
after compilation began, versus 553.99s with WASM enabled. The build's long
dependency path continues through the shell/builtins and final native addon.
Reducing optional grammar support alone did not remove that bottleneck.

## Behavior and validation

`pi-ast` and `pi-natives` default to no WASM. An explicit native build with
`OMP_NATIVE_FEATURES=wasm-grammars` restores optional grammar loading for
comparison or broader language support. The PTY test wrapper forwards that
selection so each comparison measures the intended feature graph.

The native grammar metadata reports whether this build can load each grammar.
Disabled grammars do not download or trigger repeated AST calls, and cached
modules from an older build cannot make unsupported parsing fail. Structural
tools explain skipped languages. The built-in language set remains available;
other languages retain ordinary text operations.

- Both macOS jobs passed standalone worker smoke, 15 grammar regressions and
  all 7 selected PTY tests (335 unrelated tests filtered out).
- Rust formatting and Clippy passed. The Linux job passed 6,218 nextest tests
  (52 skipped) and 6 doctests (27 ignored), completing in 13m 04s. Test-target
  compilation took 4m 21s and nextest execution took 305.721s.
- Local `check:ts`, formatting, workflow parsing and 15 focused tests passed.
  Local tests initially used the prior addon; both freshly compiled modes were
  then checked on their macOS runners.
- The full TypeScript runtime suite was not part of this timing experiment.

Both downloaded archives were SHA-256 verified:

| Mode | Archive SHA-256 |
| --- | --- |
| enabled | `0e024f3d7cd4f12c34c6b94704fc3a5624b09db5695c3492cc2ab088d73fd4ae` |
| disabled | `657ca033b70f8aaad249ae642d6047829de4712570e84a58e5d1e963fb424112` |

Full logs, metrics, Cargo HTML timing reports, generated bindings and binaries
were recovered under `dist/validation/wasm-2026-11-17/` locally. Its manifest
records source identity, run IDs, configuration, results and evidence hashes.
