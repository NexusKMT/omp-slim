# 裁剪审计报告（2026-11-12）

审计方法：全仓 LOC 普查（TS/Rust，排除 node_modules/dist/target）+ 3 个只读侦察任务（死导出/设置键、web 面、Rust 面）+ 逐项消费者验证。审计于 2026-11-12 上午完成；同日下午按第二节逐项执行删除并完成测试对账。

## 一、当前规模快照

TypeScript（13 包）：src 2,153 文件 / 758K 行；测试 2,428 文件 / 620K 行。

| 包 | src 行 | 测试行 | 备注 |
|---|---|---|---|
| coding-agent | 436.9K | 447.2K | 最大单体：agent-session.ts 13.6K、interactive-mode.ts 9.2K |
| tui | 192.7K | 90.7K | |
| utils | 38.9K | 16.9K | |
| ai | 18.7K | 16.7K | 传输已收缩到 providers/openai-completions.ts 等 1.7K |
| agent | 16.5K | 20.0K | |
| stats / omptype | 16.0K / 14.0K | 7.0K / 13.7K | omptype 被 ai/agent 283+ 处引用，活 |
| 其余（natives/metaharness/snapcompact/wire/catalog/benchmark） | ~20K | ~6K | |

Rust（12 crate，含 vendor）：~708K 行。pi-shell 342K、pi-builtins 173K、pi-natives 55K、pi-edit 34K、pi-walker 15K、pi-vcs 14K、pi-vfs 7.6K、pi-predict 8.3K、pi-ast 8.2K、pi-iso 5.1K、pi-diff 1.2K、vendor 45K。

依赖：Cargo 工作区 20 项（pi-builtins 55、pi-natives 51、pi-shell 42、pi-ast 36 项/箱）；Bun 包依赖 coding-agent 22+1、tui 8+1 最多。

仓库卫生：.git 843M（pack 776 MiB / 5,395 对象）——历史缩减是仓库卫生项，不计入代码裁剪估算。

## 二、已执行的删除（2026-11-12 本日提交）

以下为审计确认的零消费者死代码，已全部删除并完成测试对账：

1. `packages/agent/src/compaction/azure-openai-endpoint.ts` — 已删（`git rm`）。
2. `coding-agent/src/session/redis-session-storage.ts` + `sql-session-storage.ts` — 已删，含 `test/session/redis-*.test.ts`、`test/session/sql-*.test.ts`、`examples/sdk/12-redis-sessions.ts`、`13-sql-sessions.ts`；`index.ts` 两行 barrel 导出已移除。`indexed-session-storage.ts`/`session-storage.ts` 保留（会话管理仍在用）。
3. `coding-agent/src/judgment/cache.ts` — 已删；`JudgeDeps.cache` 字段、5 个 `cache: sharedJudgmentCache()` 调用点（judgment-bridge/standalone/agent-session/builtin-session/jfind）全部移除；连带 `utils/dirs.ts` 的 `getJudgmentCacheDbPath` 一并删除。
4. `hasNativeJudge` 死桩 + `JudgeKind` 的 "native"/"local" 分支 — 已删：`withCandidate` 回调不再携带 `kind`，`auto-graph/planner.ts` 的 local 关键词分支与 `kindQuestion` 已删；`tools/jfind` 的 `auto` 判定改为直接 `false`（无原生判官，避免消耗聊天模型 token）。`test/judgment-chain.test.ts` 断言已重锚。
5. `cli/help-extra.ts` 死供应商 env 帮助块 — 已删；仅保留 OPENAI_API_KEY（含 models.yml `<PROVIDER>_API_KEY` 说明）、NODE_EXTRA_CA_CERTS、EXA/FIRECRAWL/PARALLEL/SEARXNG_ENDPOINT 与 Configuration 项。
6. 供应商名残留文案 — `main.ts` 的 API key 提示改为 `OPENAI_API_KEY (or <PROVIDER>_API_KEY…)`；`plugins/doctor.ts` 移除 ANTHROPIC_API_KEY 检查；`rpc-mode.ts` 注释中 ollama 示例改为实际存在的发现源（proxy / models.yml `discovery:` / 导入的 coding-agent 配置）。
7. Rust：pi-predict 预测引擎（ngram/smollm/prose + web-prior.bin.zst + build-web-prior.ts）已删；`pi-predict` 收缩为 `apple::appkit` 拼写服务（`pi_natives::spelling` 的唯一消费方）。`pi-natives` 删除 `predict.rs` + `lib.rs` 的 mod 声明；工作区 candle-core/candle-nn pin 已移除（全仓无其他消费者）。⚠ 按审计保留 `pi_predict::apple::appkit`。
8. 随 #7 的死 TS：`TEXT_PREDICT_WORKER_ARG`（worker-selectors.ts）、`getPredictStateDir` + 仅其使用的 `adoptLegacyDir`（utils/dirs.ts）、ps-data.ts/jsonl-server.ts 陈旧注释 — 已删；`utils/test/dirs-xdg.test.ts` 的 predict 路由与 legacy-adopt 断言已移除。
9. 原生生成物：`packages/natives/native/index.d.ts` 的 TextPredictor 声明 + `index.js:42` 的 shim 因本机无 cmake（napi 构建需要）无法重生成，暂留（零 TS 消费者，shim 有 `missingNativeClass` 兜底，仅实例化时报错）。后续在 CI 重跑 `bun run build:bindings` 后以生成物为准。

P0 全部落地；P1（显式-only 搜索引擎尾）与 P2（blob-broker / 外部会话导入 / IDA / eval+benchmark / scraper 长尾）在早前提交中已按产品决策执行完毕。

## 三、产品决策级裁剪点（活代码，需拍板）

| 候选 | 行数 | 现状与证据 |
|---|---|---|
| 显式-only 搜索引擎尾（zai/kagi/tavily/brave/tinyfish/keenable/kimi/deepseek/jina/ollama/synthetic） | ~2.4K + 共享客户端 web/kagi.ts | 21 个引擎全部注册于 web/search/provider.ts:12-42，与 TUI 标签 1:1；默认自动链只含 10 个，其余 11 个需显式 engine=。无死代码——侦察确认 deepseek.ts 等走独立 REST/MCP 密钥，与已删传输无关 |
| Scraper 长尾（77 文件 / ~15.6K） | 按站点取舍 | 全部经 tools/fetch.ts:1120-1145 可达；read/fetch 是保留核心。仅按价值取舍（docs-rs 20K、reddit 18.5K…） |
| Blob-broker 对象存储/上下文图片（7.7K） | 7,724 | blob-broker/ 被 cli.ts/images-cli/all-settings/sdk/snapcompact-inline 消费——活功能（含 aws-sigv4 的 S3 上传）。若 slim 不需要对象存储上传可整体裁 |
| 扩展框架 extensibility/（skills/hooks/plugins/extensions） | 26.2K | 活（插件加载器、legacy shim 均可达） |
| eval/ 评测桥 + benchmark 工具链 | eval/ 15.3K + typescript-edit-benchmark 包 4.4K + bench-cli 1.4K + if-bench 769 | 开发自测工具；cli.ts 只烟测 eval worker，judgment-bridge 被会话消费。产品可用则裁 |
| 外部会话导入（claude/codex 会话店 + foreign-session-*） | 1.3K + claude-trace-cli 809 | main.ts:112-117 接线；Claude/Codex 会话导入功能 |
| IDA Pro 集成 src/ida/ | 2.1K | cli.ts/all-settings/tools 接线；小众工具集成 |
| 设置迁移块 config/settings.ts:3399-3493 | ~95 | 仍在启动时删除退休键——用户迁移完成后可删 |

## 四、优先级总表

| 优先级 | 动作 | 预估收益 | 状态 |
|---|---|---|---|
| P0 | 删 pi-predict 死引擎（保留 appkit）+ candle 依赖图 | 7K Rust + 大额构建/体积 | ✅ 已执行（见 二.7–9；原生生成物待 CI 重生成） |
| P0 | 删 redis/sql 会话存储 + 2 个 SDK 示例 | ~790 TS | ✅ 已执行（见 二.2） |
| P0 | 删 azure-openai-endpoint + judgment cache + 死桩 + 帮助文案 | ~330 TS | ✅ 已执行（见 二.1/3/4/5/6） |
| P1 | 显式-only 搜索引擎尾（11 个） | ~2.9K TS | ✅ 已执行（早前提交） |
| P2 | 产品拍板项：blob-broker / 外部会话导入 / IDA / eval+benchmark / scraper 长尾 | 2K~26K 各 | ✅ 已执行（早前提交，按产品决策） |
| 后续 | .git 历史缩减（5,395 对象 / 776 MiB pack） | 仓库卫生 | ⏳ 未做，需 force-push 决策 |

## 五、核查后确认「不建议动」

- pi-shell 342K / pi-builtins 173K：NAPI 面（shell/pty/ps/glob/grep/fd/ast/edit/vcs/iso/diff）全部被 TS 消费，无死入口证据。
- legacy-pi-ai-shim：运行时插件加载器字符串引用（legacy-pi-compat.ts:975），活。
- models-config-schema-bundle（83 行）：被 models-config.ts 消费，活。
- web 面 112 文件：无任何死文件/死注册；无已删传输接线残留。
- aws-sigv4（223 行）：被 blob-broker S3 上传使用，不是 Bedrock 残留。

## 六、裁切后回归修复（2026-11-12 同日晚）

Chat Completions 单一传输裁切（0d73ddd567）在删除兼容键（`reasoningContentField`、`requiresReasoningContentForToolCalls`、`stripThinkingHistory`）时，连带删掉了 reasoning 解码、回显与 wire 侧 thinking 保留，导致 DeepSeek 类端点（moxuna deepseek-v4-pro）在多轮对话中返回 HTTP 400（`The reasoning_content in the thinking mode must be passed back to the API`）。修复分两处提交：

- `99065feb1e`（ai 包）：重新解码 `reasoning_content`/`reasoning`/`reasoning_text` 流 delta 为带 `thinkingSignature` 的 thinking block；编码侧按 `isReasoningSourceSignature` 回显 `reasoning_content`（剔除 Mistral typed-parts 签名）。
- `dcb5e6b7cf`（agent 包）：删除 `normalizeMessagesForProvider` 对 thinking 的无条件剥离——该剥离在 0d73ddd567 前由 `compat.stripThinkingHistory` 门控，裁切后变为无条件执行，使编码器永远拿不到可回显的 thinking block。wire 策略现在唯一收口在 openai-completions 编码器（thinking 不上线，除 `reasoning_content` 回显外）。

端到端验证（桌面隔离环境 `~/Desktop/omp-slim-test`）：thinking→tool call→follow-up 两轮无 400；resume 已存历史会话的路径同样通过。
