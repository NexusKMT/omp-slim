# Slim integration, build and maintenance cost — 2026-11-19

The trim has reduced dependency and source scope substantially. Its main added
cost is maintaining a coherent downstream contract across configuration, old
sessions/extensions, test fixtures and native distribution. There is no measured
evidence here of increased runtime overhead. Fewer source lines alone establish
neither faster execution nor a better test suite.

## Source and verification boundary

The source submitted for this build is
`ae480c973c183d9ca66fc19a25ed6a7d8546418d`, on public `NexusKMT/omp-slim/main`.
The cleanup was initially based on `e8d1f678b3`. Fetching before submission found
48 remote commits ending at `ea3ca64360`, including deletion of stats,
metaharness, Nix, telemetry, research consumers and additional tests, and the
catalog's move into `ai`.

Integration produced 86 conflicted paths, including 61 modify/delete conflicts.
The applicable cleanup was rebased onto the remote changes, preserving those
removals. The integrated cleanup changes 80 files, with 1,368 insertions and
7,813 deletions relative to `ea3ca64360`; these counts include documentation and
test data, not just implementation. The temporary Python model bridge and
benchmark config exporter were discarded along with their deleted consumers.
The shared configured-model resolver remains for the surviving TS tools.

This is a measured coordination cost of diverging checkouts during broad
deletion, not an estimate of recurring effort on every future change. The five
earlier audit/cleanup reports now explicitly identify their older source tree;
their test totals must not be attributed to this integrated source.

Local checks on the integrated tree:

- `bun install --frozen-lockfile`: passed.
- `bun run check:ts`: passed; 81 existing lint warnings remain.
- Six affected test files: 15 passed, zero failed, 45 assertions. These exercise
  configured model resolution, maintenance-tool requests, Slim configuration,
  annotation model inheritance, extension selection and CLI model deferral.
- A direct schema probe confirms that an unknown compatibility key is discarded.
  No real model endpoint or user credentials were used for this probe.

Remote workflow: [Intel macOS run 44549416311](https://github.com/NexusKMT/omp-slim/actions/runs/44549416311).
Native/standalone compilation, architecture/signature/load-path checks and worker
smoke passed in 11m39s. PTY regressions passed in 10s and `check:ts` in 18s.
The full TS gate failed: **135 of 157 command groups passed, 22 failed**, in
479.8s. These are process groups, not individual tests. Logs contain 54 failure
reports across 30 reported file paths, including a repeated imported TUI suite.
The original run is therefore **not** a fully validated release.

The audit found a concrete product regression among these failures: the minimal
default prompt stopped rendering `alwaysApplyRules`, although rules were still
loaded and supplied to the template. Thus `RULES.md` did not reach the model.
Commit `06ef50a1eac0ba28dbe5ea5b33d9438bed3bdb89` restores rendering of supplied
user customization and always-apply rules in eight template lines. It does not
restore the removed boilerplate. The malformed-template regression now checks
that user rules survive fallback, replacing its assertion of an old policy
heading. Forty existing tests across rules reload, scoped rules, template
fallback and prompt deduplication pass with 119 assertions; `check:ts` passes.

[Follow-up run 44556806308](https://github.com/NexusKMT/omp-slim/actions/runs/44556806308)
checked the native input fingerprint, reused the addon from the first run, and
packaged/verified this repaired source before repeating the TS gate. The final
result is **136 of 157 command groups passed, 21 failed**, in 530.7s: 44 failure
reports across 27 reported file paths. The three rule/scoped-session/template
test files repaired above no longer report failures. An SDK fallback test still
asserts the removed policy heading; it is listed separately among the remaining
failures. The full workflow remains failed. Reusing the matching addon avoided
another full native rebuild for a prompt-only product change.

Generated native declarations and JS exports recovered from the first run match
the tracked files byte for byte. The first archive and extracted executable
passed their SHA-256 checks locally; `--version`, `--help` and `--smoke-test`
passed with isolated config directories. The recovered addon also passed an
actual local macOS spelling check (the hosted job skips that service check).

| First-build artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `omp-darwin-x64.tar.gz` | 97,499,342 | `1db646eafe8b50f2ed5acc54483577ef9e2bac0fcbd367fa0a3fe7f5afd2e3ea` |
| Extracted `omp` | 188,638,192 | `5c0f3a130940ebeed37206594007c8015050c67a26341b2da5630a754a83a7f9` |
| `pi_natives.darwin-x64-modern.node` | 93,884,000 | `2fbb3b6dc96cfb6ec0462f93fc91569973e1534180e14f73955cc06d95553386` |

Recovered files are under `dist/actions/44549416311/`; these artifacts contain
the initial source and do not include the later prompt fix. The repaired CLI
passed remote packaging and smoke in 73s, including 51s of CLI compilation.
It was recovered under `dist/actions/44556806308/binary/`, checked against its
archive and executable SHA-256 manifests, and passed local signature,
`--version`, `--help` and worker-smoke checks with isolated configuration.
Its native provenance confirms identical build inputs and the same addon digest
as the first build. The existing installed user CLI was not replaced.

| Repaired artifact, source `06ef50a1ea` | Bytes | SHA-256 |
| --- | ---: | --- |
| `omp-darwin-x64.tar.gz` | 97,499,026 | `bc946060377ae07d2f59ee306f503067ea4c35cfa59576c8e601b2e9dac30e34` |
| Extracted `omp` | 188,638,192 | `f20bb04365112f378a8358793a2460f18a95ea0a378235baeb7dabb7704e500f` |

Native compilation itself took 626s in the
first run, CLI compilation 50s, and the remaining time in the 699s build step
covered checks and packaging. These durations are not a controlled comparison.

## What became smaller

The comparison uses the pinned upstream baseline
`21f1188cf88b2f534c092181968cd5a4d1a9c296`, recovered from upstream and measured
directly. The local `v18.18.3` tag resolves to a different commit,
`7e8e0b8297afab0b40be28245dc4c6c44f8b5222`; its tree lacks two generated data
files present in the pinned baseline. Both revisions are included in the local
evidence, and the source/dependency rows below are identical for them.

| Measurement | Pinned `21f1188cf8` | Integrated `ae480c973c` | Change |
| --- | ---: | ---: | ---: |
| Bun lockfile package entries | 462 | 245 | −47.0% |
| Cargo lockfile package entries | 979 | 739 | −24.5% |
| Bun workspaces, including the root | 18 | 10 | −8 |
| JS/TS-family files under `src`, physical lines | 1,105,341 | 636,521 | −42.4% |
| Dedicated test paths, physical lines | 1,128,544 | 497,907 | −55.9% |
| Other Rust source, including inline tests, physical lines | 705,292 | 603,894 | −14.4% |
| Scripts/bench/research paths, physical lines | 79,910 | 23,705 | −70.3% |
| Recognized test fixtures/snapshots, physical lines | 79,360 | 76,144 | −4.1% |
| Documentation, physical lines | 73,839 | 50,471 | −31.6% |

These are tracked-file measurements from `git archive`, excluding installed
dependencies and build output. Classification is heuristic and mutually
exclusive: recognized vendor paths, generated/declaration paths and fixture
paths precede test/source classification. Physical lines include comments and
blank lines; generated files or vendored implementations without recognizable
paths can remain in source buckets. The dedicated-test bucket can also contain
test support data. This is not a count of handwritten product logic, executable
test cases, coverage or engineering effort.

Lockfile entries are not the set of dependencies compiled for one target. Cargo
entries increased from 737 on the earlier local tree to 739 after integration:
the retained PTY crate and Linux keyboard dependency were added while direct
Windows dependencies were removed. A smaller product does not require every
intermediate count to decrease.

## Added costs and decisions

| Area | Evidence in the integrated source | Cost and recommended treatment |
| --- | --- | --- |
| Real behavior lost at a retained boundary | The reduced default template consumed skills but omitted loaded always-apply rules. Rule-loading code remained active, so type checks could not detect the lost output. | Highest immediate priority; fixed in `06ef50a1ea` and verified by the existing behavior tests. This is a reason to retain tests of user instructions reaching the request, even after deleting prompt-wording tests. |
| Test assumptions after catalog removal | 155 coding-agent test files reference `getBundledModel`, `getBundledModels` or `GeneratedProvider`. Their shared 37-line helper synthesizes one Chat Completions model with image input, four effort levels, zero prices and a 200k context window. | High priority for targeted review. Tests can look like they cover different suppliers while exercising the same synthetic capabilities. Replace misleading fixture assumptions with explicit capability inputs when touching the affected behavior; delete assertions for removed behavior. The reference count does **not** establish that all 155 files are useless. |
| Default-role compatibility spread | 14 production source files mention role APIs/types; `session/role-models.ts` is 50 lines and ignores its `_role` argument. Settings still exposes the default-role aliases and mirrored settings operations. | Moderate maintenance cost, little apparent algorithmic cost. Move internal callers to the canonical model API before considering removal of compatibility at extension, persisted-session or worker-message boundaries. Simply deleting the aliases can break consumers that still exist. |
| Manual endpoint capabilities | One transport remains, but image/tool support, effort mapping, context limits, pricing and wire options come from configuration. Unknown fields are silently removed. A probe with `supportsUsageInStreamng: false` retained only the correctly spelled `supportsStore` option. | Some provider-maintenance work has shifted to the endpoint operator. Configuration spelling mistakes can be harder to diagnose. The current guide now documents the actual stripping behavior; introducing diagnostics would be a separate behavior change, not a reason to restore a vendor catalog. |
| Native packaging and distribution | `scripts/slim/` plus the three active workflows total 1,713 physical lines, including benchmarking/diagnostic machinery. The fork owns target selection, toolchain/cache compatibility, native declarations, worker packaging, checksums and artifact recovery. | Recurring ownership cost. Keep the ordinary build/smoke path small; retire experiment machinery when its measurements are no longer needed. Reuse a verified addon for TS development. A full native/standalone rebuild is an integration gate, not the default feedback loop. |
| Documentation and validation drift | The model guide still referred to `packages/catalog`; it described unknown fields as errors. Root instructions still claimed retained stats and a removed SDK workflow. Earlier test reports described an older checkout. | Immediate cleanup completed in this assessment: correct live guides and label historical results by revision. Build/test reports must identify their exact source. Otherwise subsequent agents can reintroduce deleted components or trust obsolete results. |
| Surviving model-backed maintenance tools | One 37-line resolver and a two-line script re-export use the real registry, settings and authentication path. The integrated tree removes the Python bridge because its consumers are gone. | Small, localized adaptation cost. Keep the shared path while consumers exist; avoid copied endpoint/auth resolution or retaining experiments solely to justify compatibility code. |

The earlier [run 44465407429](https://github.com/NexusKMT/omp-slim/actions/runs/44465407429)
at `7bcef6f05b03fa7b7761e6c9d5eadc312cd5a7d2` illustrates the distinction between
compilation and test reconciliation: native/CLI compilation completed in 11m02s,
the PTY and TS gates passed, but 21 of 160 TS groups failed after roughly 8m13s.
Logs include tests asserting settings/discovery behavior already removed from
that source. Subsequent commits removed some of those stale cases, so these are
historical failures, not a claim that the same 21 groups fail at `ae480c973c`.

The added role wrappers and synthetic fixture helper are small in line count.
Their cost comes from how many callers still rely on old concepts. Conversely,
an old-session migration or a retained shell/session regression test can remain
valuable even if it mentions a removed supplier. Names and test age alone are
insufficient deletion criteria.

The current failure log provides concrete next-review targets:

- Clearly retired subjects include `/skills search`, `stats` argv routing,
  foreign-agent MCP discovery, `--from-claude`, the legacy environment alias and
  the removed `session_recaps` table. Mixed files still contain useful tests;
  this evidence does not justify deleting every failing file.
- Marketplace discovery now uses OMP extension roots, while a test expects
  marketplace packages to be excluded from those roots. The slash-command
  fixture also omits the runtime link and OMP manifest needed by the current
  loader. Align these tests with real installation before declaring the
  surviving marketplace contract broken.
- Tests expecting removed default policy/personality/visual guidance need a
  contract review. Rules delivery was a real regression and has been repaired;
  a missing boilerplate heading alone is not the same failure.
- Yield-report, transcript-rebuild and terminal-layout failures remain separate
  investigations. Their names do not prove they are obsolete. No claim is made
  that the remaining complete suite is green.

## Priority after this build

1. Classify failures of the integrated remote gate by current user-visible
   behavior. Repair retained contracts; remove tests whose entire subject was
   deliberately removed. Do not suppress failures merely to obtain a green run.
2. Simplify the synthetic-model fixture contract and the tests that depend on
   its universal capability defaults. Retain representative model-resolution,
   wire, session replay, compaction, edit and shell failures, not repeated
   supplier-name rows exercising one path.
3. Reduce internal default-role plumbing while keeping any required persisted
   or external compatibility at the boundary. Measure the affected consumers
   before deleting an exported method or worker operation.
4. Keep source revisions, addon digests and completed validation together.
   Review upstream fixes selectively against the retained features; avoid
   treating a broad upstream merge or a new total-line count as verification.

No CPU, memory or request-latency regression is established by this audit.
Previous compiler experiments changed Cargo profiles and cache conditions;
their improvements must not all be credited to feature deletion. The current
build records an actual integration duration, not a controlled before/after
performance experiment. Core session/edit/shell contracts still need meaningful
tests regardless of the desired size of the test tree.

Local evidence is under `dist/validation/maintenance-cost-2026-11-19/`:
`source-counts.json`, the one-off `measure.py`, `dependencies.jsonl`,
`unknown-field-probe.json`, `check-ts.log`, `focused-tests.log`,
`rules-regressions.log`, `check-ts-rules.log`, both Actions logs/status records,
both failure lists and `local-artifact-verification.json`. These are ignored
audit artifacts, not a new permanent measurement framework. The recovered
follow-up validation artifact is in `dist/actions/44556806308/validation/`.
No OMP Slim Codespace was running at the end. The only listed Codespace belonged
to a different repository, was left alone, and reported `Shutdown` on the final check.
