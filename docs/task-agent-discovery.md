# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time. Every task, eval worker, seance, and Vibe worker inherits the current parent session model, including its provider route.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- required `name`, `description`, and `systemPrompt`
- optional `tools`, `spawns`, `thinkingLevel`, `output`, `blocking`, `structured`, `autoloadSkills`, `readSummarize`, `advisor`
- `source`: `"bundled" | "user" | "project"` (extension agents are tagged with their extension root's project/user level)
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing/non-string `name` or `description` => invalid (`null`), caller treats as parse failure
- `main` and `sub` are reserved names (checked after trimming and lowercasing); definitions using them are invalid
- `tools` accepts CSV or array; legacy tool aliases are normalized and mixed arrays retain their string entries. Omitted or YAML-null `tools` selects the default built-in toolset. Any other declaration with no tool names (including `tools: []`, empty CSV, or malformed scalar/array values) selects no built-ins. Structured children still receive the required `yield` tool; MCP, extension, and custom tools remain additive.
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data
- `read-summarize: false` (normalized to `readSummarize`) disables structural summaries for the subagent's `read` tool — `runSubprocess` applies a `read.summarize.enabled: false` override on the child's isolated settings (`src/task/executor.ts`). `scout` ships with it disabled. When absent, the child inherits the parent's read-summary setting.
- Legacy frontmatter `model` and `prewalk` fields do not select or switch a worker model.
- `thinking-level` / `thinking` selects effort on the inherited primary model. When `task.enableEffort` exposes it, a task item's `effort` (`lo`, `med`, `hi`) takes precedence at launch. OMP maps that hint to the model's lowest, middle, or highest supported effort, then clamps it to `task.maxEffort`. If no supported effort fits the ceiling, the spawn fails; models without a controllable effort surface use their normal behavior.
- `blocking: true` makes the parent wait for that agent even when async task execution is enabled
- `structured: true` keeps structured results for that agent while `task.structured` (default `false`) is off: its task spawns get the `yield` tool and resolve their output schema exactly as with `task.structured: true` (see [structured-output precedence](#model-and-structured-output-precedence)). With `task.structured` on, the field changes nothing; `false` or absent follows the setting. The caller-side `outputSchema`/`schemaMode` task parameters stay hidden while the setting is off. The decision is made from the resolved agent in `resolveEffectiveSubagentPolicy()`, so plan-mode spawns keep it, and cold revival restores `yield` from the child's persisted tool list.
- `autoloadSkills` names skills from the parent session to inject before the first child prompt; unknown names are ignored
- `advisor: true` enables an advisor using the same current model as its owning worker. `task.agentAdvisor[agentName]` can enable or disable it with `"on"` / `"off"`. Legacy advisor model strings only enable the advisor; they cannot select another model. The effective opt-in is persisted for revival.

## Custom agents

OMP discovers user agents from `~/.omp/agent/agents/*.md` and project agents from `.omp/agents/*.md`. Agent definitions specialize instructions, tools, output schemas, and effort while using the parent session's current model.

For example, save `~/.omp/agent/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review a change for concrete correctness problems
tools: read, grep, glob
---
Review the assignment and report concrete correctness findings with supporting evidence.
```

With the batched task schema, supply shared `context` and per-item `task` and `solutionSpace`. Set `agent` when choosing a non-default agent:

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    {
      "agent": "reviewer",
      "task": "Report concrete correctness findings.",
      "solutionSpace": "Review causes and failure modes; no known defect."
    }
  ]
}
```

Choose the primary model manually with `/model` before dispatch. Model-role mappings, model-tagged agents, and per-call model selectors are retired.

## Watch running agents

After dispatch, press `Alt+A` to open [Agent Hub](./agent-hub.md). Its live roster shows each task agent's status, current activity, model, age, and usage. Select an agent to read its transcript and steer it directly; parked agents can be revived from the same view. Enable `tui.mouse` to click live task cards and jump-list rows instead, or watch the pinned `Subagents` block above the editor.

### `vibe_spawn` tiers

`vibe_spawn` maps `fast` to bundled `sonic` and `good` to bundled `task`. Both use the current parent model. The tier chooses the worker definition and its execution constraints.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `scout`, `reviewer`, and `security-reviewer` from prompt files
- `task` and `sonic` from the shared `task.md` body plus injected frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, unrecoverable YAML errors or invalid required fields throw and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home, extensionRoots?)` (`src/task/discovery.ts`) merges agents from OMP-native roots, OMP extension packages, and Claude marketplace plugin roots before appending bundled definitions. Direct cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped — their frontmatter schema is not the OMP task-agent contract (`TASK_AGENT_CONFIG_SOURCE = ".omp"` filters the native config-dir lists).

### Discovery inputs and precedence

1. Nearest project `.omp/agents` dir from `findAllNearestProjectConfigDirs("agents", cwd)` (first `.omp` hit only)
2. User `.omp/agents` dir from `getConfigDirs("agents", { project: false })` (first `.omp` hit only)
3. `<extension-root>/agents` for every enabled OMP extension package returned by `listOmpExtensionRoots(...)`, in this order:
   - explicit CLI `--extension` / SDK `additionalExtensionPaths` directory roots
   - the session's effective `extensions:` array, in its configured order
   - installed npm/link plugins
     Project and user `extensions:` arrays are not concatenated: settings use array-replacement precedence. Session overlays/runtime overrides and the configured array's project/user provenance are preserved. In `explicit-only` mode (`--no-extensions` or SDK `disableExtensionDiscovery`), only explicit roots contribute this package surface; file entrypoints have no `agents/` subdirectory to scan.
4. Claude marketplace plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs — only when `isProviderEnabled("claude-plugins")`; project-scope plugins sort before user-scope. User-scope roots additionally require the `claude-plugins` or `claude` user source to be enabled (`isUserSourceEnabled`: normally via `enabledProviders`, e.g. `["claude-plugins"]`; `claude` is also enabled implicitly when `CLAUDE_CONFIG_DIR` is set), except roots whose origin is not the foreign `~/.claude/plugins` tree (omp's own installs with `origin: "omp"` and `--plugin-dir` roots) — mirroring the skills path's exemption.
5. Bundled agents (`loadBundledAgents()`)

The OMP extension-package surface is disabled when the `omp-plugins` capability provider is disabled. Marketplace roots are excluded from `listOmpExtensionRoots` and enter only through the separately gated Claude-plugin path.

Legacy frontmatter model selectors never determine task routing, regardless of whether the definition came from an OMP agent, an extension package, or a Claude plugin.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project `.omp` overrides user `.omp`.
- Earlier extension roots override later extension roots, Claude marketplace plugins, and bundled agents.
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- the default lenient parser normalizes line endings and kebab-case keys, replaces tabs in YAML, and can repair ambiguous plain scalars before reporting failure
- an unrecovered parse error at `warn` level logs a warning, then falls back to top-level `key: value` lines
- fallback values are individually parsed as YAML when possible, preserving scalar/array types
- if required fields remain invalid, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by the directory loader (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- unrestricted sessions default an omitted `agent` field to `task`
- a restricted parent `spawns` list defaults an omitted `agent` field to the first listed agent

`resolveEffectiveSubagentPolicy()` is shared by task and eval-backed subagent launches. Before allocating artifacts it:

1. atomically reloads the live session's persisted global, project, and explicit overlay settings while preserving runtime overrides
2. resolves the omitted or explicit agent name from the parent spawn policy
3. enforces depth, blocked-self-recursion, and parent spawn-policy guards
4. rediscovers agents with the session's cwd and effective extension-root configuration, merges inherited session agent definitions, and performs exact lookup
5. checks `task.disabledAgents`
6. resolves plan-mode restrictions, output schema, model policy, and isolation policy

A missing name fails preflight with `Unknown agent "...". Available: ...`; no subprocess runs.

### Description vs execution-time discovery

`TaskTool.create()` memoizes discovery by working directory and effective extension roots when building the tool description. Execution reloads settings and rediscovers agents, so the runtime set can differ when files change mid-session. Blocking behavior comes from the resolved execution-time agent.

## Model and structured-output precedence

Task dispatch uses the current parent model. Agent frontmatter, legacy `task.agentModelOverrides`, roles, and extension hooks cannot route a child to a different model. The task and eval schemas omit `model`; legacy callers that pass it receive a preflight error. `before_subagent_spawn` can still block a launch, but returning a replacement model is rejected.

Every worker request is checked against its inherited model identity. Automatic model fallback and provider-side model fallback are disabled. Missing credentials or an unavailable model fails the request instead of choosing another model. Seance retains the selected transcript context while using the current parent model. Revived workers take the current live parent's model when available and otherwise retain the saved inherited model.

Manual effort, tool selection, output schemas, service tiers, and account pools remain independent controls on the same model. Advisors and compaction also use their owning session's current model.

Compaction triggers are separate from model and service-tier selection: an exact, case-sensitive
`task.agentCompactionThresholdOverrides[agentName]` entry (`90000` or `"80%"`) replaces the
`compaction.threshold*` settings for that agent only; agents without an entry, including agents it
spawns, use the main session's thresholds. See [Settings](./settings.md#context-compaction-and-memory).

Request budgets follow the same exact-name pattern: a `task.agentSoftRequestBudget[agentName]` entry
(a non-negative integer) is that agent's soft request budget, replacing both `task.softRequestBudget`
and the bundled scout/sonic ceiling, so it can raise a budget the global setting can only lower; `0`
disables that agent's guard, and `null` clears an entry from a lower settings layer. Agents without an
entry keep the global setting capped by their bundled ceiling. See [task](./tools/task.md#limits--caps).

Service-tier precedence is independent of model selection: an exact, case-sensitive
`task.agentServiceTierOverrides[agentName]` entry overrides `tier.subagent`; an absent entry preserves
the global behavior. `inherit` snapshots the parent session's live per-family tiers (including
`/fast` changes) for the next spawn. The child session resolves a concrete value against the model
inherited from the parent and populates only that model's provider family when the family
supports the value. The resolved map is persisted with the child's session, even when it is empty, so a
parked agent revived after a restart keeps its per-agent tier instead of re-deriving
`tier.subagent`. The entry is looked up by task/eval dispatch only; Vibe workers launched through
the same executor keep `tier.subagent`. Service tiers are configuration-only; agent frontmatter and
the task/eval wire formats do not expose a tier field or automatic Fast policy.

Account selection is independent of model and service-tier selection: an exact, case-sensitive
`task.agentAccountPools[agentName]` entry maps provider ids to OAuth identity keys (the `identityKey`
values broker [client account pools](./auth-broker-gateway.md#client-account-pools-routing-not-authorization)
use, such as `email:<address>|org:<id>` for Anthropic; [`omp usage accounts`](./cli-reference.md)
lists them). For each listed provider the child authenticates
only with those accounts: ranking, the parent's copied account affinity, restored pins, fallback
passes, credential rotation, and saved-reset restores stay inside the pool, and runtime,
environment, and stored API keys
are not used; a `models.yml` `apiKey` for the provider fails the request instead of sending a pooled
token to that endpoint. When no pooled account can serve, the request fails with `No API key for
provider: … restricted to its OAuth account pool` instead of borrowing another account; an empty
list allows no account. Saved resets about to expire are still salvaged on every account, because
salvage serves the account that holds the reset. Pools select accounts for the inherited model; they never pick another model or provider. The pool covers every key lookup the agent makes, whatever provider
session id it carries: fresh or reset sessions, advisors, title generation, skill compression, and
subagents it spawns without their own entry (an entry of their own replaces it). Vibe workers take
the pool from their first turn, and a parked agent revived in the same process or after a restart
takes the live entry for its agent name. A custom SDK `getApiKey` resolver bypasses pools.

Runtime output schema precedence is:

1. the task item's explicit `outputSchema`
2. agent frontmatter `output`
3. parent session `outputSchema`

The task item's optional `schemaMode` overrides the parent session mode; the default is `permissive`.

These schemas apply only to structured runs. With `task.structured` off (the default), task spawns get no output schema and no `yield` tool and return their final assistant message, except for agents whose definition sets `structured: true`; those resolve the agent `output`, then the parent session schema, because the task item's `outputSchema` is not exposed. Eval `agent()` and workpool spawns are always structured.

Explicit caller schemas are validated during preflight in both modes. Agent/session schemas are preflight-validated when the effective mode is `strict`. Invalid schemas fail before child execution.

The model-facing prompt (`src/prompts/tools/task.md`) tags read-only agents and warns against offloading reasoning to `scout`/`sonic`.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`resolveEffectiveSubagentPolicy()` checks `task.disabledAgents` after resolving the agent. A disabled name fails preflight and lists enabled alternatives when available.

### Parent spawn policy

The resolver checks `session.getSessionSpawns()`:

- `"*"` (also `true`, `null`, or absent) => allow any; omitted `agent` defaults to `task`
- `""` or `false` => deny all
- CSV list => allow only listed names; omitted `agent` defaults to its first name

If denied: `Cannot spawn '...'. Allowed: ...`.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` (or the internal request override) rejects an attempt to spawn the same blocked agent before discovery.

### Recursion-depth gating

`task.maxRecursionDepth` defaults to `2`; a negative value disables the cap. The shared policy rejects a spawn when the current task depth has already reached the cap. When a child reaches the cap, `runSubprocess` also removes `task` from its tool list and sets its spawn policy empty.

For an explicit agent tool list, `runSubprocess` auto-adds `task` when `spawns` is declared and depth permits it. The legacy `exec` entry expands to `bash` plus `eval` when an eval backend is available. A list containing `task` or `bash` also gains `wait` unless the parent requires an exact restricted tool list; tool construction still omits `wait` when there is no async, IRC, or service wake source. Outbound peer messaging requires `write` in the child tool list and IRC enabled; inbound steering does not.

## Plan mode behavior

When parent plan mode is enabled, `resolveEffectiveSubagentPolicy()` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `grep`, `glob`, and `web_search`, plus `ast_grep` when the agent's own tool list declares it
- clears child spawns

Plan mode also rejects eval-defined tools and per-spawn isolation, apply, and merge controls. The same `effectiveAgent` is used for subprocess launch, effort, and output-schema selection. Planning uses the current model.
