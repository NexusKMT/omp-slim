# OMP Slim Project

This checkout is the public `NexusKMT/omp-slim` downstream. Read `SLIM.md` for
the pinned baseline, requested removal scope, build commands and Codespace
lifecycle. Use the NexusKMT GitHub account for this project. Upstream
publishing scripts and archived workflows are removed; downstream Linux
builds can use Codespaces, and validation plus Intel macOS builds use manual
public GitHub Actions workflows described in `SLIM.md`. Record actual build and removal status, recover artifacts
with checksums, and verify the Codespace is stopped when the task ends unless
the user asks to keep it running. Preserve the core session/edit/shell behavior
while removing browser, desktop, speech and long-term-memory integrations.
The user chose public visibility to use free standard Actions runners. Keep
Actions build jobs gated on a public repository; do not run them privately.
The user limits concurrent agents to five total, including the coordinating
agent. Use at most four worker agents. Workers must not spawn or resume child
agents; reuse idle workers for reviews instead.
Use Chrome DevTools MCP for live Actions logs when `gh` cannot expose the
running job's log. Use `gh run watch` or `gh run view --json` as supporting
status checks, and `gh run view --log` / `--log-failed` plus `gh run download`
for completed logs and artifacts. Save logs locally and search them with `rg`.

# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

|Package|Description|
|---|---|
|`packages/ai`|Chat Completions streaming client, model metadata, effort, and pricing helpers|
|`packages/agent`|Agent runtime with tool calling and state management|
|`packages/coding-agent`|Main CLI application (primary focus)|
|`packages/tui`|Terminal UI library with differential rendering|
|`packages/natives`|Bindings for native text/image/grep operations|
|`packages/omptype`|ArkType-compatible schema validation with a lazy JIT runtime|
|`packages/utils`|Shared utilities (logger, streams, temp files)|
|`crates/pi-natives`|Rust crate for performance-critical text/grep ops|

**Model and AI import convention**: code in this repo imports model-building, thinking, and pricing helpers directly from `@oh-my-pi/pi-ai` (or subpaths `@oh-my-pi/pi-ai/build`, `@oh-my-pi/pi-ai/effort`, `@oh-my-pi/pi-ai/models`).

## GitHub

- Before posting a GitHub comment or creating an issue, MUST show the target and proposed text and obtain user confirmation. An explicit instruction to post supplied text to a specified target already counts as confirmation.
- A request to address or fix PR feedback permits drafting replies, not posting them without confirmation. A request only to get or check comments is read-only.
- When authorized to resolve review feedback, MUST verify the fix, obtain approval for a factual reply citing the change and verification, and post it in the existing thread before resolving. NEVER resolve if the reply is unapproved or posting fails.
- Permission to work on a PR does not authorize unrelated comments or issue creation.

### Pull requests

When authorized to create or edit a contributor-submitted PR, follow the checklist below.

- MUST read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` first. Preserve the template sections and checklist, including when shortening an existing description.
- MUST obtain at least one sentence written by the contributor in their own words explaining what changed and why, as required by `CONTRIBUTING.md`. If it is missing, ask the contributor; NEVER generate a substitute. Preserve that sentence during edits.
- For user-facing changes, MUST follow the [Changelog](#changelog) attribution rules. Internal issue fixes keep their issue links. For external contributions, add the PR link and contributor credit after GitHub assigns the number, then push the entry before marking the changelog checklist item complete.
- MUST read back the published PR description after creating or editing it. Check only verified checklist items; explain skipped or inapplicable checks in `Testing`.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Judge questions**: one JSON file per feature (`src/prompts/judge/<feature>.json`) maps question ids to `{ instructions, criteria? }`. Load it with `judgeQuestions(file)` from `@oh-my-pi/pi-ai`; fill Handlebars instructions with `renderQuestion(question, context)`. `criteria` sets the kind: a list of levels → score, omitted or `true`/`false` keys only → yes/no, any other labels → choice (`{}` when the caller supplies the labels). Choice labels and answer types come from the JSON keys.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_js_eval` and the other registered worker selectors) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the omp CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `omp --smoke-test` exercises the retained workers and local services (JS eval, subagents, terminal output, and the daemon brokers), checks their responses, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary and source-link installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `rg` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts` are the only sanctioned way to run git/jj (`import * as vcs from "@oh-my-pi/pi-natives/vcs"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

|Operation|Use|Not|
|---|---|---|
|File read/write|`Bun.file()`, `Bun.write()`|`readFileSync`, `writeFileSync`|
|Spawn process|`` $`cmd` ``, `Bun.spawn()`|`child_process`|
|Sleep|`Bun.sleep(ms)`|`setTimeout` promise|
|Binary lookup|`$which("git")` from `@oh-my-pi/pi-utils`|`spawnSync(["which", "git"])`|
|HTTP server|`Bun.serve()`|`http.createServer()`|
|SQLite|`bun:sqlite`|`better-sqlite3`|
|Hashing|`Bun.hash()`, `Bun.password.*`, WebCrypto|`node:crypto`|
|Path resolution|`import.meta.dir`, `import.meta.path`|`fileURLToPath` dance|
|JSON5|`Bun.JSON5.parse()` / `.stringify()`|`json5` package|
|JSONL|`Bun.JSONL.parse()` / `.parseChunk()`|`text.split("\n").map(JSON.parse)`|
|String width|`Bun.stringWidth()`|`get-east-asian-width`, custom|
|Text wrapping|`Bun.wrapAnsi()`|custom ANSI-aware wrappers|

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Model and Platform Scope

OMP Slim supports only explicitly configured `openai-completions` endpoints and
one selected main model. Model capabilities come from configuration and
`packages/ai/src/models/build.ts`; never infer capabilities from provider/model
names. There is no bundled provider catalog, KDL rule tree, `gen:compat`, or
`gen:models` command. See `docs/models.md` and `docs/slim-single-model.md`.

Standalone model-backed tools should reuse `config/configured-model.ts`; interactive
helpers should inherit the active session model. Delete retired experiments and
their unused prompts instead of retaining source copies as text archives.

The supported product targets are macOS Intel and Linux x64. Full native and
standalone compilation runs remotely through the public manual Actions
workflows in `SLIM.md`. Local type checks, focused TS tests, and formatting checks
are appropriate; do not start a full local native build.

The development goal is fast feedback after each code change. For TypeScript,
run the source CLI with `bun run dev` and test the affected files; reuse the
verified native addon in `packages/natives/native/`. A standalone binary build
is not required to observe TypeScript changes. Restart the source process to
load edited modules. Use package type checks for a local change and `check:ts`
for the wider TS gate; root `bun check` can also start the Rust workspace gate
when this branch contains earlier Rust changes.

For Rust development, use `CARGO_INCREMENTAL=1 bun run check:rs --package CRATE`
and `CARGO_INCREMENTAL=1 bun run test:rs --package CRATE`, optionally
`-E 'test(NAME)'` for nextest. OMP injects `CI=true` into tool commands, which
otherwise disables incremental compilation on the pinned Cargo even locally.
Explicit package selection runs even on an otherwise unchanged branch and
retains that package's doctests. Small independent crates such as `pi-pty` can
be checked locally; checks requiring the full native graph still run remotely.
Measure a real edit/check/run cycle with a retained target directory before
claiming that developer feedback has improved. Whole-build and release checks
remain integration gates, not a prerequisite for every local edit.

## Generated Files

RPC wire changes must regenerate the retained wire definitions with `bun run gen:rpc` and
validate the affected clients. Native declarations are generated from Rust by
`build:bindings`; `packages/natives/scripts/gen-enums.ts` derives the JS exports
from those declarations. When removing native exports before a remote rebuild,
remove their declarations and regenerate the JS exports, then verify the full
native build remotely.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation; `bun test` processes write theirs to a per-user `omp-test-logs-<uid>/` under the OS temp dir instead. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- Never run `cargo test` directly for Rust tests — use `bun run test:rs`. It runs `cargo nextest run` (config: `.config/nextest.toml`) followed by a `cargo test --doc` pass, because nextest does not execute doctests. The doctest pass runs every runnable doctest in the workspace's lib crates; today that is tree-sitter-go's one example (pi-natives is a `cdylib`, which rustdoc skips; pi-builtins' examples are `ignore`d vendored uutils docs).
- `bun check`'s Rust half runs only when the branch changed a Rust-affecting file (`*.rs`, `crates/`, Cargo/toolchain files) since its merge base with `upstream/main` or `origin/main`, committed or not; it always runs in GitHub Actions, when that cannot be determined (e.g. shallow clone), or with `OMP_FORCE_RUST_TASKS=1`.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.
## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

|Profile|Use|
|---|---|
|`dev`|Cargo build/check default; `test` inherits its settings. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. Native builds require `OMP_NATIVE_CARGO_PROFILE=dev`.|
|`release`|Inherited upstream profile: fat LTO, 1 codegen unit, stripped.|
|`local`|Default for `bun run build:native`: O3, thin LTO, 16 codegen units; requests incremental in the manifest.|
|`profiling`|`release` codegen with symbols kept. Its fat LTO differs from the downstream shipping `ci` profile.|
|`ci`|Downstream standalone/native build: O3 without LTO, no debuginfo, stripped.|

The pinned Cargo disables incremental compilation by default when `CI` is set,
even when the profile has `incremental = true`. Development feedback benchmarks
must explicitly use `CARGO_INCREMENTAL=1` and verify the effective unit graph
before compiling. Preserve the chosen environment throughout the measured edit
loop. The first 2026-11-17 dev/local comparison and frontend matrix actually ran
with incremental disabled; see `docs/slim-compiler-investigation-2026-11-17.md`.
Start performance experiments with one representative edit and a retained build
directory; expand the matrix only after checking the effective flags and result.

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`. This is a disk-space mechanism, not proof of faster OMP builds.

The earlier 196 MB → 130 MB metadata example, 131 MB → 214 MB panic example,
and claim that sccache measured slower came from upstream commit `ce1d1fee68`.
No corresponding OMP Slim measurement was recovered in the 2026-11-20 audit;
do not use those numbers as downstream results or prohibit further measurement
on that basis. Official sccache documentation excludes incremental compilations
and crates that invoke the system linker, including cdylib/bin/proc-macro.
Keep `panic = "unwind"`: retained shell/native error recovery depends on it,
and Cargo's normal test harness also uses unwind. See
`docs/slim-build-audit-2026-11-20.md` for sources and current evidence.

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.

### Good vs. bad test filter

- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it.
- **Good: transformation.** One fixture MAY prove parse/render/normalize/encode/resolve behavior when output is computed, not echoed.
- **Good: branch or boundary.** Distinct inputs, empty values, malformed input, version/provider routing, and state transitions MUST prove distinct outcomes.
- **Good: external contract.** Exact bytes/shape MAY be asserted when a provider, parser, protocol, or persisted consumer reads them.
- **Good: precedence or negative contract.** Keep explicit `false`/override-wins assertions and required absence only when they prevent a documented leak, downgrade, 400, or incompatible wire field.
- **Good: regression.** A repro MUST trigger the prior real failure path and assert the corrected observable result.
- **Bad: static echo.** NEVER test a constructor/builder merely copied a fixture or baked constant into an in-memory config/metadata field.
- **Bad: success passthrough.** NEVER assert `fn(x) === x` when `x` was already supplied/declared valid; assert a transform, rejection, or downstream effect instead.
- **Bad: wording/defaults.** NEVER assert prompt/UI boilerplate, a default literal, object existence, non-empty output, or length growth without a consumer contract.
- **Bad: duplicate rows.** Parameterized/loop rows MUST each cover a distinct branch, provider/model path, or consumer contract; delete same-path duplicates.
- **Metadata exception.** Exact metadata, identity, ordering, or `undefined` MAY remain only when a downstream consumer depends on it and the test establishes branch, precedence, negative-contract, wire, or regression evidence.
- **Termination exception.** For cyclic/large inputs, assert a bounded output, surfaced error, or state change; bare `not.toThrow()` is insufficient.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code _looks_, not what it _does_: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or an oxlint rule — never a string scan of the source. (Reading a file your code _wrote_ — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Use `bun run fix:changelogs` to normalize changelog sections when needed; this fork does not ship an upstream publishing command.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Downstream Distribution

Use the source and verified build artifacts of `NexusKMT/omp-slim`, following
`SLIM.md`. The upstream npm package, Homebrew tap, mise source and installer do
not distribute this fork. Self-update and startup release checks are removed.
Do not use upstream publishing scripts to distribute OMP Slim. Record actual
source revisions, checksums and validation outcomes for downstream artifacts.
