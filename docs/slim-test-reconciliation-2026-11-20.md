# OMP Slim 测试收敛记录（2026-11-20）

本轮从 `cb0b6a50be157164fefee3e812f405e45934177f` 继续，代码提交为
`136570d870433ea7bc2d94b4f7ec31140c5d26ee`，随后补充测试提交
`f37c6d4688b06dd34c18076c87151169b9f24ad4`。前一次完整验证
[44571654491](https://github.com/NexusKMT/omp-slim/actions/runs/44571654491)
为 136/157 个测试命令分组通过、21 组失败；该结果不能算作全量通过。

## 删除和调整的依据

按当前 Slim 的实际支持范围处理失败，而不恢复已经退出的功能或提示词。

| 情况 | 本轮处理 | 保留的行为保障 |
| --- | --- | --- |
| 外部 coding agent 的配置目录、MCP 导入、插件缓存 | 删除专用 discovery 测试，以及混合文件中依赖 Gemini、Claude、OpenCode 来源的用例 | OMP 原生扩展发现、会话级禁用设置、MCP 启停、已安装插件与 LSP 行为 |
| 退出的 stats、skills search、changelog、recap、旧环境变量 | 删除独占用例或替换失效输入 | 用 `gc` 验证 CLI 路由，用 plugins 验证子命令补全；保留 SQLite 损坏恢复中的提示和标题数据保障 |
| 默认提示词和欢迎文本已经精简 | 移除旧标题/措辞断言，改用用户规则、显式模板或固定页头 | 自定义模板回退、PERSONALITY.md 覆盖、security URL 条件暴露、图像工具的文件写入限制、滚动后编辑器位置 |
| 插件安装测试仍假定 marketplace 包不会进入 OMP loader | 按现有原生安装和加载约定修正预期，补齐插件 manifest 与运行时链接 | 安装后发现、启用、禁用和项目作用域行为 |

删除的完整文件为 `discovery/agent-discovery-disabled-providers.test.ts`、
`discovery/mcp-enabled-import.test.ts`、`sdk-visuals-prompt.test.ts`、
`slash-commands/detached-draft.test.ts`，以及已经为空的
`agent-session-anthropic-native-compaction.test.ts`。

两个代码/测试提交共修改 34 个文件，增加 138 行、删除 752 行，净减少 614 行。
其中测试涉及 26 个文件，增加 94 行、删除 746 行，净减少 652 行。
这些行数只描述维护体量变化，不代表质量或性能收益。

## 测试揭示的真实问题

### 最终 assistant 消息与工具执行竞态

`sdk-yield-report` 的两个用例和 issue #12247 的会话重建用例在修改前均能本地复现：
流生产者已经发布 `message_end` 并继续执行工具，消费端却还没有把最终 assistant
消息写入 Agent 状态或 SessionManager。表现为 `yield` 找不到报告文本，或重建上下文
漏掉正在执行的 tool call。

Agent 现在在最终 `message_end` 已交付状态和同步订阅者后释放正式工具派发边界；
AgentSession 再等待现有的消息持久化队列。等待不包含异步通知监听器，也没有用
`sleep` 猜测事件时序。事件消费者退出时会释放交付等待。参数预处理和工具参数修订
仍先于最终消息发布，因此这里没有改变审批/参数修订的时序。
已有的推测读取仍可提前执行；本次针对的是最终消息之后的正式派发和结果提交。

正常最终事件和仅通过 `result()` 返回最终消息的路径都应用这一边界。保留原有
yield、会话重建、延迟通知、暂停、取消和推测执行回归测试，仅给已有 yield 用例表
增加一项零事件流输入，覆盖不同的最终消息处理分支。

### 精简模板遗漏动态能力数据

开启 `inlineToolDescriptors` 时，工具描述会从 API 工具定义中移到提示词；精简模板
原先没有渲染已经生成的 `toolInventory`，于是两处都没有描述。模板现已条件渲染该
数据，现有异步 task 工具指引测试和动态工具启停测试均通过。

技能列表现在输出具体的 `skill://<name>` 地址，让保留的技能 reader 可以被找到。
没有恢复已删除的通用行为口号或默认 personality 段落。

生产代码净增加 35 行，包括显式交付确认、持久化回调以及模板数据恢复。
消息队列和持久化实现沿用现有机制，没有新增轮询、固定延时或存储层。
这是修复可复现行为所需的成本，尚未单独测量其性能开销。
本轮也没有证明所有剩余测试都值得保留：审查范围是完整 gate 中的已知失败、
相关退出功能及此次修复影响到的保留行为，不以用例数或覆盖率作为质量结论。

## 本地验证

使用 Bun 1.4.4 和已核验的 Intel native addon。原始证据位于
`dist/validation/test-reconciliation-2026-11-20/`。

| 验证 | 结果 |
| --- | --- |
| 首轮修改文件定向验证 | 421 pass / 4 fail；暴露一个新 CLI fixture 输入错误，以及本地 `PI_CONFIG_DIR` 与临时 home 路径不一致导致的三个插件 fixture 失败 |
| 修正输入和测试进程环境后：yield、会话重建、CLI、marketplace、task 指引 | 107 pass / 0 fail（5 文件） |
| 最终消息、暂停、取消、推测执行、队列准备、yield 零事件分支 | 58 pass / 0 fail（6 文件） |
| 第二轮技能开关断言调整 | 6 pass / 0 fail（1 文件） |
| `bun run check:ts` | 通过；已有 lint warning 仍存在，未声称零 warning |
| `git diff --check` | 通过 |

这些命令有重叠用例，不把它们相加当作去重后的测试总数。首轮失败及其日志保留。
插件测试使用临时 home 并按默认 `.omp` 构造目录；本地定向命令取消了额外传入的
`PI_CONFIG_DIR`，与远程测试步骤的环境一致，仍通过 `PI_CODING_AGENT_DIR` 隔离会话数据。

## 完整集成验证

[44581839289](https://github.com/NexusKMT/omp-slim/actions/runs/44581839289)
在公开的 `NexusKMT/omp-slim` 仓库、`macos-15-intel` runner 上验证上述代码提交。
工作流核验 native 输入兼容后复用 `44571654491` 的 addon，重新编译当前 CLI，
再运行完整 TypeScript gate。本轮没有 Rust 或 native 接口修改。

该轮完整 gate 为 **156/157 组通过、1 组失败，耗时 516.8 秒**。
余下两条失败都在 `skillful-toggle.test.ts`：它仍匹配旧的 `- test-skill:` 排版，
而本轮模板已输出 `skill://test-skill`。原先 21 个失败分组对应的问题均已处理，
但这个新增的断言适配遗漏使工作流仍为失败，不能记录成通过。

补充提交只把这两项用例的开启/关闭断言改成实际技能地址，保留同一文件中的
运行中切换、隐藏技能、只发一次通知和 slash command 行为测试。六项本地通过后启动
[44584226996](https://github.com/NexusKMT/omp-slim/actions/runs/44584226996)
验证 `f37c6d4688b06dd34c18076c87151169b9f24ad4`。最终为 **157/157 组通过、
0 组失败，耗时 635.0 秒**，工作流整体成功。这是测试命令分组数，不能写成
157 个测试用例；通过的组包含 agent、AI、utils、natives、TUI 及 coding-agent 各类测试。

首轮 CLI 编译记录为 64 秒；包含架构/签名检查、worker smoke 和打包的步骤共 91 秒。
这是本次集成构建的耗时，不是相对于前次的性能结论。复用 addon 的源码为
`8e3f7ea1d0f4fe5c449380635b2e08846cfb0c3b`，工作流已核对 native 输入、生成绑定、
版本、架构和保留/删除的导出。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Actions binary ZIP | 97,446,788 | `d146f117d1d4c86dba2300e0c27013a7dc46231af4ce98d2ad5eb8ad114af588` |
| `omp-darwin-x64.tar.gz` | 97,528,523 | `80ecd7ec9cf0497a2a32ae5c08bb411750798ec43afd46810a64e06af2891654` |
| `omp` | 188,671,216 | `f8789bd273b6d6ab8de1668de93ee2065def94c8eaae57c5cfe83446cbd8813a` |
| 复用 native addon | 93,884,000 | `2fbb3b6dc96cfb6ec0462f93fc91569973e1534180e14f73955cc06d95553386` |

ZIP 按 GitHub artifact digest 验证，内部压缩包与可执行文件再分别按随附 checksum
验证；源码提交相符，构建前后工作区干净。本机解包产物的 Intel 架构、严格签名验证、
`--version`、`--help`、`--smoke-test` 全部通过，后者耗时 6.582 秒。
本机直接运行真实 AppleSpell 集成用例为 2 pass / 0 fail，补足 hosted runner
因系统拼写服务超时而跳过的外部服务检查。

首轮回收产物位于 `dist/actions/44581839289/`；逐项校验记录位于本轮证据目录中的
`artifact-verification.json`、`local-binary-verification.json` 和 `local-spelling.log`。
验证日志 ZIP 也已按 GitHub digest 核验，SHA-256 为
`d0d5622b398c72db65a4737b0f3be184b2baa72c4a088c8c5f9735c256a56a75`。
该轮远程 `check:ts` 无错误，仍有 99 条 lint warning。

第二轮回收产物位于 `dist/actions/44584226996/`：

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Actions binary ZIP | 97,446,785 | `06fd17514600723da43c64c853e94e61b233fbceee9026d259700d89a61aa870` |
| `omp-darwin-x64.tar.gz` | 97,528,528 | `f1c4a5bf74739584ab0719a121071bacb27d27171ff6c4b5b9eca9b95d6001f1` |
| `omp` | 188,671,216 | `f8789bd273b6d6ab8de1668de93ee2065def94c8eaae57c5cfe83446cbd8813a` |

第二轮 ZIP、内部包、可执行文件、源码提交和构建前后干净状态均已核对；本机架构、
严格签名、version/help 和 worker smoke 全部通过，smoke 为 5.701 秒。证据在
`final-artifact-verification.json` 和 `final-local-binary-verification.json`。

第二轮仅修改测试，编译出的 CLI 与首轮字节完全一致；编译耗时却从 64 秒变为
120 秒，整个打包验证步骤从 91 秒变为 151 秒。未定位这一时长差异的来源，
不能将不同 runner 的单次时长归因于运行时代码变化或据此声称构建优化效果。

第二轮验证日志 ZIP 为 56,742 字节，按 GitHub digest 核验的 SHA-256 为
`a45dda7107b2800b54cdabec0ecdbd79f5f00e071a40b48321067e3ef9037d88`。
原始日志在 `dist/actions/44584226996/validation/`，分组结果在本轮证据目录的
`final-full-gate.json`；Actions 最终状态在 `final-actions-status.json`。
`check:ts` 通过但仍有既有 lint warning。没有在这轮重新运行完整 Rust 构建/测试；
native 输入一致性与复用前完整构建的 PTY 等结果分别记录，避免扩大验证范围。

任务结束时没有本项目活动 Codespace；账户下另一仓库的 Codespace 为 Shutdown。
