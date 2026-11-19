# 维护脚本裁剪对账（2026-11-19）

> Historical audit on the `e8d1f678b3` working tree. The later integration with
> `ea3ca64360` preserves additional remote removals (catalog merged into ai;
> stats, metaharness, research and many old tests removed). Counts and validation
> below describe that earlier tree, not the integrated build. See the build and
> maintenance-cost report for the final source and verification.

本轮从 `main` 的 `e8d1f678b34eb123e0af913032498db0ba931506` 继续，核对实际代码及提交历史。该提交已移除 RoboOMP；前一提交 `c6c5d4521e` 已完成 TextPredictor 原生绑定清理。

## 本轮改动

以下五处维护工具统一复用 `scripts/configured-model.ts`，从 OMP 的 `config.yml` / 项目设置选择主模型，再通过现有 `ModelRegistry` 读取 `models.yml`、本地凭据或环境变量。显式模型参数仍可覆盖选择；无配置、模型不可用、供应商被禁用或缺少凭据时返回配置错误。

| 工具 | 修复后的行为 |
| --- | --- |
| `scripts/rewrite-system-prompt.ts` | 使用配置的 Chat Completions 传输、端点及请求头；移除固定 OpenRouter 地址、Claude 模型和专用环境变量要求 |
| `scripts/rewrite-changelog.ts` | 使用配置的主模型；移除对已删除 auth broker 和内置模型目录的引用 |
| `scripts/session-stats/audit.ts` | 分类模型默认跟随主模型；缓存标识记录实际解析的模型 |
| `packages/metaharness/scripts/trace-report.ts` | 摘要与归纳阶段默认使用主模型；显式 `--tiny` / `--synth` 解析配置中的模型 |
| `.omp/skills/tool-prompt-optimization/scripts/probe.ts` | 默认只采样主模型；显式 `--model` 仍支持配置中的模型列表 |

删除了失效的 `claude:trace`、`check-spoofed-versions` 命令及包装脚本。前者引用已删除的 trace CLI，后者读取已删除的供应商版本定义。移除测试中对已卸载 Babel traverse 的正控夹具和已经退休的 `cacheWarming` 参数；保留 legacy 扩展运行时及 SDK 异步路由的行为测试。

通过 `bun run gen:nix` 重新生成 `nix/bun.nix`，移除 523 行过时依赖定义；`bun.lock` 未改变。修复脚本类型检查暴露的 Bun musl 编译目标拼写及安装测试服务器的返回类型。使用仓库格式工具修复基线中 28 个文件的格式问题，相关变更仅涉及格式。

## 本地验证

环境为 Intel macOS、Bun 1.4.4，复用本机已有原生插件。运行测试时设置隔离的 `PI_CONFIG_DIR` 和 `PI_CODING_AGENT_DIR`；新增请求测试使用临时配置及本机 HTTP 服务。

| 验证 | 结果 |
| --- | --- |
| `bun run check:ts` | 通过，包含全仓 lint、4,493 个文件的格式检查和全部工作区包的类型检查；仍有原有 lint 警告 |
| 脚本及提示词探针类型检查 | 通过，1,858 个文件；临时 tsconfig 继承 `tsconfig.tools.json`，关闭只适用于声明项目边界的 `composite` 限制，并额外包含 `.omp` 中的探针脚本 |
| `bun test --only-failures --timeout 30000 scripts` | 140 通过，0 失败，389 个断言，20 个测试文件 |
| reasoning 回显、mock transport、目录隔离、内部 URL 补全、thinking 持久化及 parked subagent 回归 | 60 通过，1 个平台跳过，0 失败，7 个测试文件 |
| 会话审计、legacy 扩展运行时及 SDK 异步路由的定向回归 | 10 通过，0 失败；其中会话审计测试也包含在上述脚本测试中 |
| 源码 CLI `--smoke-test` | `smoke-test: ok` |
| `bun run gen:nix` | 通过 |
| `git diff --check` | 通过 |

新增测试验证实际请求的模型 ID、Chat Completions 路径、API key、自定义请求头和无鉴权端点；同时覆盖项目设置优先级、显式模型覆盖、禁用供应商、无效配置与缺少凭据的错误。命令级测试实际执行提示词重写、changelog 重写、探针和 trace 报告，检查文件或标准输出结果。

完整日志保存在本机 `/tmp/omp-slim-verify.nyUJWt/`，主要结果为 `check-ts-final.log`、`tools-types-final.log`、`scripts-tests-final.log`、`focused-tests.log`、`script-existing-tests.log`、`smoke.log` 及 `gen-nix.log`。

本轮没有重新执行全部工作区行为测试、真实模型端点测试、Rust 测试、Nix 构建或发布二进制构建。上述结果不替代这些验证。

## 后续裁剪对账

本报告记录第一阶段五处维护工具修复及当时的验证结果。随后发现的主 CLI、benchmark runner、TB 安装器、Python 评测及其他遗漏已在[后续修复](slim-heuristic-fixes-2026-11-19.md)中处理。共享解析器已移入 `packages/coding-agent/src/config/configured-model.ts`，原脚本模块保留兼容导出。

后续的[启发式审计](slim-heuristic-audit-2026-11-19.md)已记录这些路径及其他遗漏的具体证据、复现结果与处理顺序。

`.claude`、`CLAUDE.md`、插件/技能格式兼容、tokenizer 名称及历史会话元数据仍可能包含供应商名称。这些兼容数据与实际模型请求的选择分别核查；没有按关键词删除用户指令、插件或会话记录。
