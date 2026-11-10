# Single-model OMP Slim

This downstream uses one selected main chat model. Configure it directly:

```yaml
model: provider/model-id
```

`--model` and `/model` still select the main model manually. Planning, approval
and execution retain that selection and its thinking level. There is no plan
model to assign. Subagents inherit the exact parent model at launch and revival,
including endpoint and routing metadata. Already-running child sessions retain
their launch model until their normal lifecycle ends; a manual main-model change
does not rewrite an in-flight child's history. Personas, task instructions,
tool permissions, concurrency and thinking effort remain available.

Model roles, role cycles, presets, per-agent and per-call model overrides,
prewalk handoffs, context-window model promotion, retry fallback chains and
composer model mentions have been removed. Legacy `modelRoles.default` migrates
to `model` only when the same configuration layer has no explicit `model` value.
Other retired role settings cannot reactivate routing. Historical session model
entries and model tags remain readable.

Advisors follow the current main model and its effort. Titles, job widgets,
skill-description compression, enabled edit repair, explicit judgments and
image questions use the current model object. Failed requests do not select a
second model. Title generation offers a fork or a separate request to this
same model; legacy `title.generator: tiny` migrates to `request`. Automatic
title-drift and unexpected-stop classification requests are removed. Mechanical
recovery of empty or thinking-only replies remains, alongside same-model retries,
credential rotation, bounded quota waits and context compaction. An unavailable
saved session model reports an error; an explicit user model choice remains possible. A text-only model preserves
image attachments and reports its capability limit instead of calling another
vision model.

The independent tiny/MLX/ONNX inference installers and workers, predictive
composer runtime, automatic judge routing, Spotlight ranking/output rewriting
and the image-generation product tool are removed. Generic provider protocols,
catalog metadata and historical data formats are retained for compatibility. Native prediction crate removal is
outside this application-level pass; no native addon input has changed.

The standalone CLI is rebuilt through `slim-macos-tests.yml` on
`macos-15-intel`. That workflow verifies and reuses the native addon from
run `42807753137`, then compiles the current application, checks its x86_64
architecture and signature, exercises its worker smoke tests and runs the full
retained TypeScript suite. The generated standalone Rust RPC SDK is not an
input to the native addon; native crates, dependencies, bindings and build
scripts remain subject to the reuse comparison.

The integrated application revision is
`d55687e51411da0d209adb1a0d746cbf236d0bec`. Local `bun run check` passed;
the unchanged native build inputs caused its Rust wrapper to skip rebuilding.
[Actions run 42867271630](https://github.com/NexusKMT/omp-slim/actions/runs/42867271630)
has passed native reuse verification, frozen installation, workspace checks,
CLI compilation, signing/load-path checks and worker smoke tests. Its complete
TypeScript run passed **212/213 command groups** in 2,311.7 seconds. The only
failure was the existing DAP timeout-cleanup fixture: on the loaded runner, its
300 ms deadline killed the adapter before the child wrote its PID file. The
workflow therefore remains marked failed; it is not a green full-suite run.

Test-only commit `34b93cb6a7` makes that fixture wait for an actual detached child
to announce readiness, then retains the 300 ms DAP timeout and asserts the real
process exits. The complete 10-file failing CI group passed locally after this
fix: **200 passed, 18 skipped, zero failed, 867 assertions**. The full DAP file
also passed all 32 tests, and coding-agent type checking passed. The full cloud
suite was not repeated after this fixture-only change. Git comparison confirmed
that product source, dependencies and build inputs remained identical to the
built revision. Later documentation commits only record these results.

The hosted job explicitly skips the AppleSpell service integration, as recorded
in `SLIM.md`; retained platform capability tests run. The unchanged addon had
already passed actual AppleSpell and concurrent PTY checks on the local Mac.

The initial integrated run
[42855739954](https://github.com/NexusKMT/omp-slim/actions/runs/42855739954)
built successfully but failed 29 test command groups. Old role, Prewalk, vision
and automatic-judge fixtures were updated or retired with their removed
features. Retained cancellation, recovery, MCP, skill loading and worker behavior
kept their functional checks; fixes also addressed cancellation during wake
setup and the renamed retry settings group. A separate model-inheritance review
found and fixed same-selector custom endpoint/header replacement in advisors
and local-model metadata refresh, plus dynamic header loss across worker revival.
Real worker tests now verify endpoint and static/dynamic headers through both
warm and cold revival. No native addon source changed in this pass.

The recovered final-revision build passed local Intel Mac checksums, source
provenance, x86_64 architecture, ad-hoc signature, version/help, worker smoke,
Shell pipelines, file round trips, nonzero exit status and compiled HTML session
export. Isolated compiled-CLI checks also passed legacy default migration,
`tiny` title-generator migration, rejection of old role writes, persistence of
the selected main model, and absence of retired settings and CLI flags.
A real compiled-CLI RPC check against an isolated loopback service passed a
normal turn, a real task subagent round trip and an explicit HTTP 400 failure.
All six HTTP requests used the selected main model, its endpoint and its
configured header; legacy role/fallback decoy models received zero requests.
The terminal failure surfaced its original error and retained the main model.
A separate HTTP 503 attempt showed same-model retries until the harness's
30-second deadline; it is recorded separately, not counted as a completed
failure-path validation. These checks used temporary profiles. Real provider
credentials were not used.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| GitHub artifact ZIP, ID `13788027371` | 114,790,994 | `afa1a57e42096ee2b402e6a6e05c8bd94a4c53f3f379bbfd494cc7a16a4ee32d` |
| `omp-darwin-x64.tar.gz` | 114,901,738 | `4e9f03bd2ebf4432ca85b5755fc15b38b6f7cd42a31dbe4e9d095a2830ee391d` |
| `omp` | 224,782,960 | `5e5154f75ed94069d468faf1513e12bedfb5ac28e6541bad338f5bb47079d239` |

Local artifact directory:
`dist/actions/42867271630/artifact/reused-cli-d55687e51411da0d209adb1a0d746cbf236d0bec/`.
The executable is `extracted/omp`; verification scripts, logs and source-size
measurements are in `dist/actions/42867271630/local-validation/`. Earlier
artifacts in `SLIM.md` predate this single-model pass. The existing Codespace was
confirmed `Shutdown`; the public Actions runner performs this build.

## Size measurement

At application source `d55687e51411da0d209adb1a0d746cbf236d0bec`, this pass changed
576 tracked text paths: 7,976 lines added, 75,709 deleted, and 67,733 removed net.
This includes tests, documentation, configuration and generated text, so it is
not a count of removed production code. Against the original upstream baseline,
tracked text is down 309,694 lines net.

| Physical source lines | Original upstream | Before single-model pass | This build |
| --- | ---: | ---: | ---: |
| Entire repository, including tests/vendor/generated code | 3,257,477 | 3,033,850 | 2,967,395 |
| `packages/coding-agent/src` | 572,436 | 507,379 | 484,645 |
| `packages/tui/src` | 206,079 | 204,846 | 196,867 |

The source reduction in this pass is 66,455 lines (2.19%); cumulative source
reduction is 290,082 lines (8.91%). This counts source-extension physical lines,
including comments and blank lines. Markdown, JSON/YAML/TOML/KDL configuration,
locks and binary resources are excluded. Production-path counts still include
any generated source and inline tests within those paths. Measurements read
tracked files and Git objects only and confirmed that the tree stayed unchanged
during counting. A large monorepo remains; the maintenance gain comes from
removing runtimes and routing branches.
