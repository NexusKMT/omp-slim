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
credential rotation, bounded quota waits and context compaction. An unavailable saved session model reports an error;
an explicit user model choice remains possible. A text-only model preserves
image attachments and reports its capability limit instead of calling another
vision model.

The independent tiny/MLX/ONNX inference installers and workers, predictive
composer runtime, automatic judge routing, Spotlight ranking/output rewriting
and the image-generation product tool are removed. Generic provider protocols, catalog metadata and historical data
formats are retained for compatibility. Native prediction crate removal is
outside this application-level pass; no native addon input has changed.

The standalone CLI is rebuilt through `slim-macos-tests.yml` on
`macos-15-intel`. That workflow verifies and reuses the native addon from
run `42807753137`, then compiles the current application, checks its x86_64
architecture and signature, exercises its worker smoke tests and runs the full
retained TypeScript suite. The generated standalone Rust RPC SDK is not an
input to the native addon; native crates, dependencies, bindings and build
scripts remain subject to the reuse comparison.

Validation is being completed on the integrated source. Focused tests already
cover configuration migration, startup and strict restoration, same-model
recovery, compaction, plan approval, exact child model inheritance, rejected
overrides, child session release, cache isolation, image capability handling,
focused UI controls and title lifecycle races. Whole-workspace TypeScript
checking and formatting passed after integrating the Spotlight removal. Build
results, final source revision and artifact hashes will be recorded here after
the integrated run finishes. Earlier macOS artifacts in `SLIM.md` describe the
previous browser/desktop/voice/memory removal and do not contain this change.

## Size measurement

At application source `e69f3fc969`, this pass changed 519 tracked text files:
6,919 lines added, 73,495 deleted, and 66,576 removed net. This includes tests,
documentation, configuration and generated text, so it is not a count of removed
production code. Against the original upstream baseline, tracked text is down
308,537 lines net.

Source-extension physical lines across the repository were 3,257,477 at the
original upstream, 3,033,850 before this pass, and 2,968,554 after it. This count
includes tests, fixtures, vendored/generated source, comments and blank lines.
Markdown, JSON/YAML/TOML/KDL configuration, locks and binary resources are
excluded. The source reduction in this pass is 65,296 lines (2.15%); cumulative
source reduction is 288,923 lines (8.87%). A large monorepo remains; the practical
maintenance gain is removal of complete runtimes and routing branches, not a
claim that the entire codebase is small.
