# 启发式审计修复（2026-11-19）

> Historical audit on the `e8d1f678b3` working tree. The later integration with
> `ea3ca64360` preserves additional remote removals (catalog merged into ai;
> stats, metaharness, research and many old tests removed). Counts and validation
> below describe that earlier tree, not the integrated build. See the build and
> maintenance-cost report for the final source and verification.

项目：`/Users/aaron/Projects/omp-slim`，基于 `main@e8d1f678b34eb123e0af913032498db0ba931506` 的工作区，承接此前维护脚本修复。此次改动尚未提交。

[原始审计](slim-heuristic-audit-2026-11-19.md)的 H1–H9 已处理。供应商专用研究实验已按后续要求删除（见[清理报告](slim-supplier-cleanup-2026-11-19.md)）；实际保留的模型请求入口使用配置的 Chat Completions 模型。没有恢复已裁剪的协议、角色或供应商目录。

## 修复结果

| 项目 | 当前行为 |
| --- | --- |
| H1 · cleanse | 省略 `--model` 时读取配置的主模型；交互 `/cleanse` 默认继承当前会话模型。发现 checker 和修复 worker 均通过父会话继承模型，不再传入已禁止的子代理覆盖参数。无效显式选择仍报错，不静默改选其他模型。 |
| H2 · 评测配置 | Harbor 和 TB 复用 `model-config.ts` 导出选中模型的端点、能力、限额、费用、认证头与兼容字段，产物通过当前严格 schema。Python Harbor 安装器直接安装导出的文件，缺少配置时明确报错；移除其旧协议生成器及静态供应商密钥映射。 |
| H3 · Python 传输 | 活动 SnapCompact adapter 与研究 `run.py` 通过 `scripts/omp_model.py` → Bun 桥接器 → OMP 模型解析器及客户端发送请求。文本、图片、system prompt、effort 与费用统计沿用当前客户端。移除活动入口的专用 env 文件和固定 API 地址要求。 |
| H4 · 默认模型 | Harbor、TB、两类 edit benchmark 和 oracle 默认读取当前主模型。显式配置的评测矩阵继续可用。移除七模型默认池、OpenRouter routing flag 和 `bench:tb-floor` 包装器。 |
| H5 · 命令入口 | 删除根目录失效的 `gen:compat`、`gen:models`。 |
| H6 · 检查覆盖 | 删除只服务于已裁剪功能的 catalog classification、Muse hashline benchmark；修复其余 8 个保留 benchmark 的接口、异步调用和类型。将保留的 bench 纳入包类型检查，增加 `check:scripts` 并接入 `check:ts`；metaharness 增加 test 覆盖、分离浏览器与 Bun 类型环境。 |
| H7 · 使用说明 | 更新主 README、TUI tips 与 metaharness 文档，移除旧登录、auth broker/gateway、quota reset、PI_DIALECT、多协议目录、独立 advisor 模型及已退休协作入口的宣传。 |
| H8 · 开发指令 | `AGENTS.md` 改为当前手工 endpoint/model schema、显式能力和单传输约定，移除不存在的 KDL / catalog 生成流程。 |
| H9 · 会话审计 | 会话扫描使用 `getSessionsDir()`；缓存位于当前 agent 目录的 `stats-audit-cache.json`，与模型解析的配置目录一致。 |

共享模型解析器位于 `packages/coding-agent/src/config/configured-model.ts`，维护脚本保留 `scripts/configured-model.ts` 兼容入口。解析器遵循项目配置优先级、禁用供应商及显式选择规则，并支持 API key 的环境变量、命令值和本地凭据存储。

评测导出冻结已解析的认证值，避免 guest 环境重新解释变量名或命令前缀；大小写不同的请求头按 HTTP 规则覆盖。显式 endpoint override 不携带原端点的认证头。Host 与 guest 的模型配置文件使用 `600` 权限，dry-run 隐藏请求头。Docker loopback URL 转为 `host.docker.internal`，Apple Container 使用 `192.168.64.1` 的 HTTP 转发，host network 保留原地址。TB 每个 trial 只导出自己的模型并通过 Vibemon 转发选定端点。

Python 响应缓存包含模型/端点身份及请求选项，避免修改 system prompt 或 token budget 后误用旧缓存。`--report --output-dir <run>` 直接读取已保存的报告，不解析模型或发送请求。

## 研究源码清理

38 个供应商专用实验、诊断脚本及旧请求客户端已删除，先前创建的文本归档也已移除。后续进一步删除固定 checkpoint 分析、衍生图表和孤立 prompt；通用 QA 评测、渲染、数据集与 parity 验证继续保留。parity 使用的纯换行算法位于 `word_wrap.py`。

复核后删除无生产消费者的 `codex-attestation.ts`、`aws-sigv4.ts` 及其专用测试、`parse-bind.ts`、`getAuthBrokerSnapshotCachePath`。清理失效 lint/format ignore 路径与 Docker 注释。`.gitignore` 的历史 RoboOMP 运行数据规则保留，防止切换旧分支后意外提交数据。

`.claude` / `CLAUDE.md`、本地插件与技能格式兼容、tokenizer 名称和历史会话元数据不因名称匹配而删除。后续清理也删除了外部上游 Pi 对照适配器和相关启动分支。

## 验证

环境：Intel macOS，Bun 1.4.4，Python 3.12.13，使用本机已有原生插件。模型行为验证使用临时配置和本地 HTTP 假服务。

| 验证 | 结果 |
| --- | --- |
| `bun run check:ts` | 通过，包含 lint、格式、维护脚本与全部工作区类型检查；保留原有 lint warnings。 |
| `bun test --only-failures --timeout 30000 scripts` | 145 通过、0 失败；21 个文件、423 个断言。 |
| metaharness、cleanse、reasoning 回显与目录隔离定向测试 | 154 通过、1 个平台跳过、0 失败；12 个文件、582 个断言。 |
| 最后一次认证头处理及脚本回归 | 9 通过、0 失败；验证配置导出重载后的实际认证头、匿名 override、主模型选择、Python 图片请求和会话目录隔离。 |
| 两个活动 Python 评测入口集成 | 使用本地微型 SQuAD 数据及假端点，验证模型选择、请求、EM/F1、实际客户端费用统计与离线报告；共 2 次本地请求。 |
| Python 语法检查 | 活动研究与修改脚本共 46 个文件可解析。 |
| 导入复扫 | 4,522 个 JS/TS 文件、26,514 条导入记录；静态内部模块解析缺失 0、解析错误 0。 |
| manifest 入口复扫 | 13 个 manifest、164 个脚本；检查范围内失效入口 0。 |
| 保留 benchmark 实际运行 | session-tree-nav、speculative-shadow-planning、event-fanout 正常完成；不以并发验证期间的耗时作性能结论。 |
| 源码 CLI smoke | `smoke-test: ok`，使用隔离配置目录。 |
| `git diff --check` | 通过。 |

新回归覆盖真实消费者边界：CLI 实际发出的模型请求、生成配置被 ModelRegistry 重载后发出的请求、Python 生成的 Chat Completions 图片消息、Harbor 生成文件及其权限、会话审计结果。Python 桥接回归在具备 `uv` 和离线 Python 3.12 时运行；本机已执行通过。

本机证据目录为 `/tmp/omp-slim-fixes.MyGoGD/`：`check-ts.log`、`scripts-tests.log`、`package-tests.log`、`regressions-final.log`、`scripts-types-final.log`、`coding-types-final.log`、`python-integration.log`、`imports.json`、`manifests.json`、`smoke.log` 及三个 benchmark 日志。原始失败复现仍保留在 `/tmp/omp-slim-audit.lRK9c6/`。

没有运行真实模型服务、Harbor/Docker/Apple Container/Vibemon 完整评测、全仓所有行为测试、Rust/Nix 构建或发布二进制构建。配置及本地请求验证不能替代远端容器网络、构建和完整任务评测；可选 `.omp/tools` canvas 依赖也不在此次检查安装范围。
