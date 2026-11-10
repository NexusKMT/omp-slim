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
second model. Same-model retries, credential rotation, bounded quota waits and
context compaction remain. An unavailable saved session model reports an error;
an explicit user model choice remains possible. A text-only model preserves
image attachments and reports its capability limit instead of calling another
vision model.

The independent tiny/MLX/ONNX inference installers and workers, predictive
composer runtime, automatic judge routing and image-generation product tool
are removed. Generic provider protocols, catalog metadata and historical data
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
checking and formatting passed before the final Spotlight removal. Build
results, final source revision and artifact hashes will be recorded here after
the integrated run finishes. Earlier macOS artifacts in `SLIM.md` describe the
previous browser/desktop/voice/memory removal and do not contain this change.
