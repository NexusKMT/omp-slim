# 裁剪后的启发式审计（2026-11-19）

> Historical audit on the `e8d1f678b3` working tree. The later integration with
> `ea3ca64360` preserves additional remote removals (catalog merged into ai;
> stats, metaharness, research and many old tests removed). Counts and validation
> below describe that earlier tree, not the integrated build. See the build and
> maintenance-cost report for the final source and verification.

审计对象是 `main@e8d1f678b34eb123e0af913032498db0ba931506` 加上[本轮维护脚本修复](slim-maintenance-2026-11-19.md)后的工作区。下文保留修复前的证据与复现记录。用户确认开始后，H1–H9 已完成修复，P3 的无消费者代码已清理；最新实现及验证见[修复报告](slim-heuristic-fixes-2026-11-19.md)和[供应商残留清理](slim-supplier-cleanup-2026-11-19.md)。

原始审计结论：存在同类遗漏，覆盖主 CLI、benchmark 配置生成、独立 Python 请求客户端、开发命令、欢迎提示及开发规范。此前通过的 `check:ts` 和脚本测试不能覆盖这些情况。

## 方法与范围

- 对 4,525 个 TS/TSX/JS/MJS 文件做语法级导入扫描，共提取 26,507 条导入记录；对相对路径和 `@oh-my-pi/` 内部包引用进行静态解析。最终无扫描解析错误，发现 3 条失效模块引用，分布于 2 个 benchmark 文件。此扫描不验证命名导出，也不覆盖运行时拼接的模块路径。
- 检查根目录和 12 个工作区包的 manifest，共 166 个脚本定义；核对直接文件入口和 `bun --cwd … run …` 转发目标。
- 搜索已退休协议、模型角色、供应商默认值、固定请求地址及已删除组件名称；对命中追踪消费者。历史元数据、迁移清理代码、测试数据及本地指令格式兼容不直接记为问题。
- 对原有包 tsconfig 未包含的 `packages/*/bench/**/*.ts` 和 `.omp/**/*.ts` 额外运行 `bun check`。
- 用临时配置复现 CLI 错误；用假的 VM 接口捕获真实配置生成函数的输出，再交给当前 schema 校验；用 HTTP 调用拦截验证 Python 请求地址。没有调用真实模型服务，没有启动 Docker、Vibemon 或远端 benchmark。

以下优先级表示修复顺序。P1 是正常入口可复现的功能阻断；P2 是工具链、运行约定或文档与实现不一致；P3 是待删除消费者复核的清理候选。

## 已确认的问题

### H1 · P1 · `cleanse` 默认模型仍是已退休的 `@smol`

证据：

- `packages/coding-agent/src/commands/cleanse.ts:24` 的 CLI flag 默认值为 `@smol`。
- `packages/coding-agent/src/cleanse/index.ts:21` 和 `:61` 的共享入口也回退到 `@smol`。
- `packages/coding-agent/src/cleanse/agent.ts:77` 调用当前 `resolveCliModel`，解析失败后直接抛错。

在临时 profile 中配置 `model: audit/chat` 和一个 `auth: none` 的 Chat Completions 模型，运行源码 CLI 的 `cleanse 'check types'`，退出码为 1：

```text
Resolving model @smol...
error: Model "@smol" is not configured.
```

这会阻断未显式传 `--model` 的 cleanse 请求路径，项目本身配置有效也无法绕过。`runCleanse` 的共享默认值还影响使用该入口的交互流程。应让它选择当前主模型，并补充省略 `--model` 的命令行为回归。

### H2 · P1 · 三处 benchmark 安装路径生成已不接受的模型配置

证据：

- `packages/metaharness/src/runner.ts:1307` 的 `writeModelsYaml`。
- `packages/metaharness/src/tb/agent.ts:106` 的 `installAgent` 配置生成。
- `packages/metaharness/agent/omp_local.py:497` 的 Python 安装路径。

这三处仍输出 `auth: oauth`、`transport: pi-native`，且没有当前必需的 `models` 数组。当前契约见 `packages/coding-agent/src/config/models-config-schema-bundle.ts:64`。

实际执行 TB 的 `installAgent`，通过假的 VM 接口捕获生成的 `models.yml`，再交给 `ModelsConfigSchema.assert`，得到：

```text
providers.audit.auth must be "apiKey" or "none" (was "oauth")
providers.audit.models must be an array (was missing)
providers.audit.transport must be removed
```

因此更换 `--model` 本身也不足以让这些安装路径适配 Slim。应统一生成显式 Chat Completions endpoint/model 配置，验证各安装分支的实际产物；不能靠恢复被删除的协议来消除错误。

### H3 · P2 · 评测入口仍直接调用专有供应商协议

这部分存在实际 HTTP 请求实现：

- `packages/snapcompact/research/anthropic_api.py:10` 固定 `https://api.anthropic.com/v1/messages`，`:14` 从指定 env 文件读取 `ANTHROPIC_API_KEY`，`:62` 构造请求。
- `packages/metaharness/src/adapters/snapcompact.py:56` 导入这个客户端，`:310` 默认模型为 `claude-fable-5`。
- `packages/metaharness/src/server.ts:398` 的 SnapCompact launch 路径会启动上述 adapter。
- `packages/snapcompact/research/providers.py:19`、`:20`、`:221` 仍保留 Anthropic Messages、OpenAI Responses 和固定 OpenRouter 地址。

通过替换 `urllib.request.urlopen` 捕获真实 `anthropic_api.complete` 构造的请求，确认目标仍是 Anthropic Messages，携带 `x-api-key` 和 `anthropic-version`，没有经过 OMP 的主模型解析器。调用使用假 key 和内存响应，未读取真实凭据或发起网络请求。

应将仍保留的评测入口迁移到 Slim 的配置与传输；如定位为历史研究资料，应明确归档并从活动 launch 路径解除注册。不能把所有 `research/` 文件默认视为不可达资料。

### H4 · P2 · 另外四处评测默认值仍覆盖本地模型选择

| 位置 | 当前行为 |
| --- | --- |
| `packages/metaharness/src/runner.ts:400` | 未传模型时固定选择 `anthropic/claude-sonnet-4-6` |
| `packages/metaharness/src/tb/cli.ts:14`、`:98` | 默认七个 OpenRouter 模型，解析默认参数已确认 |
| `scripts/edit_benchmark_common.py:33`、`:852` | 默认静态多供应商模型列表，直接传给 RPC 客户端 |
| `scripts/rate-edit-tool.py:47`、`:54`、`:1429`、`:1504` | 固定测试模型列表及 Claude oracle 模型 |

这些默认值未读取当前主模型，可能导致当前配置下直接找不到模型，也可能在另有配置时选择用户未显式指定的评测模型。应保留明确指定的评测矩阵能力，将默认值改为主模型或要求显式指定矩阵。

### H5 · P2 · 根目录仍公布两个失效的生成命令

`package.json:125` 和 `:126` 的 `gen:compat`、`gen:models` 转发到 catalog 包，但 `packages/catalog/package.json` 已没有这两个脚本，原生成目录也已删除。

两条命令均已实际执行，退出码为 1：

```text
error: Script not found "gen:compat"
error: Script not found "gen:models"
```

应删除失效命令和相应开发指导，或在确实存在新生成需求时替换为现存入口。

### H6 · P2 · benchmark 未纳入常规类型检查，已有多处接口漂移

`packages/coding-agent/tsconfig.json:3`、`packages/catalog/tsconfig.json:3` 只包含 `src`、`test`、`scripts`，没有 `bench`。额外检查共报告 32 个诊断，涉及 11 个文件。其中 `.omp/tools/tui.ts` 的 5 个诊断源于独立可选依赖未安装，单独列在后文；其余是 10 个 benchmark 文件中的 27 个代码诊断。

| 文件 | 发现 |
| --- | --- |
| `packages/catalog/bench/classify.bench.ts:9` | 导入已删除的 `compat/cascade`、`compat/taxonomy`；实际执行报模块不存在 |
| `packages/coding-agent/bench/muse-hashline.ts:5` | 仍导入已删除的 Responses provider、`getBundledModel`，并访问退休模型属性；实际执行报模块不存在 |
| `packages/coding-agent/bench/session-tree-nav.bench.ts:11` | 从旧模块导入已搬迁的 `buildSessionContext` 和类型；实际执行报命名导出不存在 |
| `packages/coding-agent/bench/speculative-shadow-planning.bench.ts:24` | 将已改为异步的 `projectJavaScriptShadowPlan` 当作同步返回值；实际执行在 `plan.operations.length` 抛出 TypeError |
| `packages/coding-agent/bench/event-fanout.bench.ts:64` | 仍传递已删除的 `ignoreLocalModelConfig` 选项 |
| `packages/coding-agent/bench/rendering.ts:40` | 主题初始化使用旧参数类型 |
| `packages/coding-agent/bench/transcript-compose.bench.ts:108` | 主题初始化使用旧参数类型 |
| `packages/agent/bench/normalize-tools.bench.ts:24` | `unknown` schema 与当前 `TSchema` 契约不匹配 |
| `packages/tui/bench/markdown-stream.ts:69` | Markdown heading 回调参数已漂移 |
| `packages/utils/bench/sse-raw.bench.ts:42` | 保存测量对象的数组仍标注为 `number[]`，导致 10 个类型诊断；不能据此断言运行时必然失败 |

应删除仅服务于已裁剪功能的 benchmark，迁移仍有价值的 benchmark，并为保留目录设置类型检查入口。当前全仓格式检查覆盖这些文件，类型检查并未覆盖。

### H7 · P2 · 欢迎提示与主 README 仍公布退休能力

- `packages/tui/src/prompt/tips.txt:19`、`:20`、`:28`、`:29` 仍推荐供应商 `/login`、`omp auth-broker` / `auth-gateway`、`/usage reset` 和 `PI_DIALECT`。这些入口或设置在当前实现中已移除。
- `packages/tui/src/prompt/welcome.ts:16`、`:24` 会嵌入这份提示列表，普通启动界面仍可能显示它们。
- `README.md:328` 开始仍宣称内置大量供应商与 OAuth 流程；`:379` 明确列出当前 schema 已拒绝的多种协议。
- `README.md:191` 和提示列表 `:30` 对 advisor 使用独立模型的描述与单主模型约定不符。

应依据实际命令注册、模型 schema 和单主模型实现更新使用说明。兼容任意自定义 Chat Completions 端点的能力可以保留，不能以此宣称旧供应商登录和原生协议仍可用。

### H8 · P2 · `AGENTS.md` 仍强制采用已删除的 KDL / 模型目录流程

`AGENTS.md:205` 至模型生成章节仍要求在 `packages/catalog/src/compat/rules/` 修改 KDL、调用 `classifyModel`、生成 `rules.json` / `models.json`，并执行上面已经失效的生成命令。当前 `packages/catalog/src/compat`、`packages/catalog/scripts` 均不存在。

这些是实际交给 coding agents 的开发指令，可能使后续修改寻找不存在的入口或恢复已裁剪的架构。应以当前手工 endpoint/model schema、显式能力字段和单一传输契约替换过时说明。

### H9 · P2 · 会话审计的模型配置与数据目录解析不一致

`scripts/session-stats/audit.ts:40`、`:41` 将会话和缓存固定在 `os.homedir()/.omp/...`；`:542` 直接从该会话根目录扫描。它没有使用现有 `getSessionsDir()` / profile 目录解析。

上一轮修复后的模型选择已经读取隔离目录和当前配置，但统计输入仍固定为默认 home 下的会话。使用 `PI_CODING_AGENT_DIR`、自定义配置根目录或其他 profile 时，模型配置和统计数据可能来自不同位置。

此项由路径和调用链静态确认，未扫描真实用户会话做复现。应统一目录解析，或提供明确的 `--sessions-root` / 缓存路径参数，并验证 profile 隔离。

## P3 清理候选

以下仅确认仓内生产消费者缺失，不能据此保证外部 SDK 用户没有使用深层导出：

| 位置 | 证据与限制 |
| --- | --- |
| `packages/coding-agent/src/config/codex-attestation.ts` | 91 行；`generateCodexAttestation` 无仓内调用，旧 Codex 请求路径已删除；不能据此声称当前聊天仍发送 attestation |
| `packages/ai/src/providers/aws-sigv4.ts` | 223 行；当前仅剩专用测试导入；旧审计所称 blob-broker 生产消费者已不存在 |
| `packages/ai/src/utils/parse-bind.ts` | 56 行；文件说明仍指向已删的 auth broker/gateway，未找到仓内调用 |
| `packages/utils/src/dirs.ts:865` | `getAuthBrokerSnapshotCachePath` 仅剩定义，未发现消费者 |
| `.dockerignore`、`.gitignore`、`.oxfmtrc.json`、`.oxlintrc.json` | 仍有 RoboOMP / browser-relay 路径与旧注释；优先级低，删除 ignore 规则前要检查是否会暴露本地历史运行文件 |

## 已排除的误报与验证限制

- `.omp/tools/tui.ts` 的 canvas 依赖在 `.omp/tools/package.json` 中声明，运行时也有明确安装提示。这是当前环境未安装独立工具依赖，不作为裁剪导致的缺失模块缺陷。
- 原 `packages/metaharness/agent/pi_upstream.py` 是外部上游 agent 的对照评测。后续用户要求删除供应商专用研究源码，适配器和启动分支现已移除。
- `.claude` / `CLAUDE.md` 的指令与插件格式兼容、tokenizer 名称、历史 session 元数据以及退休设置清理分支不因名称匹配而删除。
- 对生产主模型解析和 Chat Completions 请求链的定向检索未发现新的固定 Anthropic/OpenRouter 请求端点；已确认的直连端点位于评测/研究客户端。这个结论限定于所查路径，不是对所有动态扩展或远端服务的证明。
- 未启动完整 benchmark、真实供应商服务、容器构建或 Nix 构建，也未重新运行全仓行为测试。文件路径扫描和类型检查不能穷尽语义问题。

## 证据位置与处理顺序

本机审计脚本和日志保存在 `/tmp/omp-slim-audit.lRK9c6/`：

- `imports.json`、`manifests.json`：静态导入和脚本入口检查结果。
- `unchecked-types.log`、`tsconfig.audit.json`：额外目录类型检查及其配置。
- `cleanse.log`：有主模型配置时 cleanse 默认角色失败。
- `generated-models.yml`、`generated-config.log`：真实安装函数输出及 schema 拒绝原因。
- `python-provider.log`：拦截记录的 Anthropic 请求地址和头名称。
- `gen-models.log`、`gen-compat.log`：失效生成命令。
- `classify-bench.log`、`muse-bench.log`、`session-tree-bench.log`、`shadow-bench.log`：四个实际失败的 benchmark 入口。

以上为原始处理顺序，现已执行。保留 `.gitignore` 中的旧运行数据保护规则，并明确其历史用途；外部上游 agent 对照评测、可选 canvas 工具和本地指令格式兼容仍按审计边界处理。
