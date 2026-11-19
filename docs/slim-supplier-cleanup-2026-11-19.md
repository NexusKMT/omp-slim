# 供应商专用研究与残留清理（2026-11-19）

> Historical audit on the `e8d1f678b3` working tree. The later integration with
> `ea3ca64360` preserves additional remote removals (catalog merged into ai;
> stats, metaharness, research and many old tests removed). Counts and validation
> below describe that earlier tree, not the integrated build. See the build and
> maintenance-cost report for the final source and verification.

工作区：`/Users/aaron/Projects/omp-slim`，基于
`main@e8d1f678b34eb123e0af913032498db0ba931506` 及前一轮未提交修复。
本轮按用户“供应商专用研究源码完全不需要，删除即可，项目级别查找类似情况并清理”的要求执行。

## 删除结果

前一轮的 38 个供应商研究源码删除继续保留，曾创建的 `.py.txt` 文本副本及其 README
已全部移除，`research/archive/` 不再存在。本轮另删除 84 个文件；合计涉及
122 个原仓库文件、38,534 行原始内容。这个计数只统计下表中的整文件删除，
不包含文档重写、先前其他修复或未提交文本归档的额外副本。

| 类别 | 文件数 | 清理依据 |
| --- | ---: | --- |
| 原供应商实验、诊断与独立客户端 | 38 | 原 `anthropic_api.py`、`providers.py`、exp01–22、供应商 bench/diag、mono/final、黑盒遮挡实验；删除文本归档。 |
| 固定 checkpoint 分析及衍生图表 | 36 | `snapcompact_*.py` 的激活、logit lens、Qwen/PaddleOCR、计费和博客可视化；无生产消费者，部分依赖已删黑盒实验。 |
| 孤立实验提示词 | 24 | exp 系列和旧 image/remote QA 附件；保留 QA text/image/session-frame 三个实际消费者使用的提示词。 |
| 上游 Pi 对照评测 | 2 | `pi_upstream.py` 及 system prompt；依赖已退休 Messages/Responses 与 auth gateway。 |
| 无调用方的供应商实现附件 | 2 | Cursor bridge 工具模块与 Anthropic 原生压缩提示词。 |
| 专用回测工具 | 1 | `scripts/session-stats/harmony_backtest.py`，固定旧供应商格式的独立研究脚本。 |
| 已退休协议与供应商开发文档 | 19 | `docs/toolconv/` 的 12 份文档，Harmony errata、供应商注册/兼容/约束/quirks/streaming 和 auth broker/gateway 共 7 份。 |

另清除已删除 Python 客户端残留的本地字节码。未删除研究输出数据或用户的模型配置、凭据及会话。

## 配套修复

- Harbor runner 移除 Pi 安装、版本、模型描述、system prompt 和专用环境变量生成分支；
  `--agent pi` / `pi-upstream` 以及保存的 Pi 对照任务在启动或恢复前明确报错，避免落入外部 Harbor 代理。
  OMP 使用现有配置导出路径；通用 Harbor 代理透传继续保留。
- 删除 OMP adapter 不再读取的旧 gateway 环境变量生成。显式 Chat Completions endpoint override
  仍通过生成的 `models.yml` 生效，并由原有配置导出回归验证。
- 通用 benchmark 汇总按完整模型名排序，移除固定供应商优先级和 `:nitro` 名称改写。
- 删除代理诊断日志中对某个供应商环境变量的特判；各配置命名空间的通用代理解析保留。
- `models.md`、`providers.md` 和 schema normalization 说明按实际源码重写；
  环境变量、设置、CLI、compaction、install ID、开发索引等同步移除旧协议、账户池、重置配额和目录发现说明。
- 修正先前报告和 metaharness README 中“归档保留”的说法；`AGENTS.md` 明确删除退休研究，
  不再保存源码文本副本。
- 保留当前配置模型的通用 QA 评测、生产渲染、字体/数据集支持及 parity 校验，补充
  [保留工具说明](../packages/snapcompact/research/README.md)。

`.claude` / `CLAUDE.md`、Gemini/Codex 本地格式兼容、离线 tokenizer、历史会话字段、
正常回归测试及已发布 changelog 中的名称保留。它们不启用专用供应商请求链。

## 搜索与核查

搜索覆盖活动源代码、脚本、benchmark、研究目录、隐藏 `.omp` 开发资源、manifest、文档和
源码文件名。对固定模型、请求地址、供应商凭据、旧协议、实验/backtest/probe/viz 名称继续追踪
引用和调用方；不依据名称直接删除仍在使用的兼容或核心功能。

静态扫描排除依赖目录、构建输出和 vendored 源码。JS/TS 扫描验证静态内部模块路径；Python
扫描验证语法并查找对本轮及前轮已删除 Python 模块的导入，不声称覆盖所有运行时拼接路径。
文档扫描没有发现指向本轮删除文件的链接。扫描另见旧协作/分享等既存文档链接问题；
它们不属于本轮供应商研究删除范围，也不计入“全部文档无失效链接”的结论。

## 验证

环境：Intel macOS、Bun 1.4.4、Python 3.12，使用已有原生插件；模型请求验证仅使用本地假端点。

| 检查 | 结果 |
| --- | --- |
| `bun run check:ts` | 通过：lint、格式、维护脚本及所有工作区类型检查。原有 lint warnings 保留。 |
| metaharness、SnapCompact、配置解析/导出/Python 桥接、proxy 定向测试 | 213 通过，0 失败，11 文件、3,120 断言。含 Pi 启动和旧任务恢复的拒绝回归。 |
| 两个保留 Python QA 入口 | 通过：当前主模型选择、请求、SQuAD EM/F1、费用和离线报告；共 2 次本地请求。 |
| 像素 parity | 5 种布局全部通过：6x12-dim、8x13-bw、8on16-bw、doc-8on16-bw、doc-8on16-sent-dim。字体取仓库副本，未联网下载。 |
| JS/TS 静态导入 | 4,521 文件、26,510 导入记录；缺失内部模块 0、解析错误 0。 |
| Python 检查 | 49 文件、403 导入；语法错误 0、已删除模块导入 0。 |
| manifest 入口 | 13 manifests、164 scripts；检查范围内失效入口 0。 |
| 文档 YAML 示例 | endpoint 和 thinking 示例通过当前 schema。 |
| 源码 CLI smoke | `smoke-test: ok`，使用隔离配置目录。 |
| `git diff --check` | 通过。 |

本机证据目录：`/tmp/omp-slim-prune.4ubOpe/`，包括 `deleted.json`、`check-ts.log`、
`focused-tests.log`、`python-integration.log`、`parity.log`、`smoke.log`、`imports.json`、
`python-imports.json`、`manifests.json`、`doc-examples.log` 和 `doc-links.json`。

没有执行真实模型服务、远端 Harbor/VM 完整评测、全仓行为测试或新的 Rust/发布二进制构建。
改动保留在工作区，未提交、推送或发布。
