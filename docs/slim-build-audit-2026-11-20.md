# OMP Slim 构建审核 — 2026-11-20

审核基线：`131cb27e2ff7bfe04b5dcd6d22cc58e3c51f9181`。范围是编译加速相关的
Cargo profile、native 构建入口、缓存与复用、PTY 测试边界、计时方法及既有结论。
依据包括官方文档、固定依赖的实际代码、重新恢复的 Actions 原始日志，以及本轮
固定工具链下的项目编译计划和隔离小工程实测。小工程只验证机制，不代表 OMP 性能。

## 已确认的问题与处理

| 级别 | 问题与证据 | 处理 |
| --- | --- | --- |
| P1 | 工作区实际加载的 native 文件仍是 11 月 13 日的旧产物，版本同为 18.18.3，loader 报 `stale=false`，但仍导出 `appleFm*`、`applyBinaryPatch` 等已删除能力。当前 `verify-native.ts` 检查实际失败。 | 备份旧文件，核对 Rust 源码/锁文件及生成绑定后，原子替换为 `44549416311` 已校验的 ci 产物。替换后导出检查、源码 worker smoke 和 6 项 PTY/shell 用例通过。版本号只说明发布版本匹配，不能证明当前 checkout 的实现已加载。 |
| P1 | native 构建未锁定 Cargo 依赖。已安装的 NAPI-RS 3.7.2 先执行无 `--locked` 的 metadata；只向后续 build 传 `--locked` 仍会先改写过期的锁文件。隔离工程复现了这一行为。 | 构建入口先执行 `cargo metadata --locked`，再向 napi 的 build 转发 `--locked`。真实入口的隔离验证确认：过期锁文件被拒绝且字节不变；有效锁文件继续进入 build，锁定及计时参数都到达 Cargo。 |
| P1 | OMP 工具命令的环境注入 `CI=true`；当前 Cargo 因而默认禁用增量编译。工作流补过开关，原日常开发命令却未补。用实际 `buildNonInteractiveEnv()` 输出环境启动当前项目的 unit graph，三个主要 crate 均为 `incremental=false`。 | 文档中的 Rust 开发命令显式设置 `CARGO_INCREMENTAL=1`，并说明作用域。没有给整个产品 shell 强加 Rust 专用开关。 |
| P2 | development benchmark 把预热后的第二次调用直接记作 unchanged；NAPI typedef 缓存创建后，force-build 环境变化仍可能使其重编。compiler matrix 虽有 settle，但也未拒绝非零编译单元。 | 两个入口均在稳定后要求 unchanged 的编译单元数为零，否则停止采样。隔离 Cargo 工程验证了环境变化重编 2 单元时拒绝、稳定后 0 单元通过、真实编辑后输出改变。本轮未修改基线的完整远程运行随后也复现：标记为 unchanged 的调用仍编译了 pi-natives。 |
| P2 | 上游例子的 `196 MB → 130 MB`、`131 MB → 214 MB` 和“sccache 实测更慢”被保留在 AGENTS 中，甚至禁止再次评估。`git log -S` 将它们追到上游 `ce1d1fee68`，未找到对应 Slim 原始实测。 | 移除无项目证据的数字与禁止评估措辞，保留已核实的机制和约束。metadata 小工程确认固定工具链接受该选项且减少 rlib 内完整元数据的重复；没有将其宣称为整项目提速。 |
| P2 | “dev 是默认”“profiling 与生产只有体积不同”省略了入口差异。`build:native` 实际默认 O3/ThinLTO `local`，交付脚本用 O3/LTO off `ci`；profiling 继承 fat-LTO release。 | 修正文档和注释；没有在缺少运行性能证据时更换默认 profile。 |
| P2 | 文档漏记 11 月 18 日已成功的增量实测，SLIM 仍把“修正后尚未重跑”当成当前状态。沿缓存 key 查到源码 `f5f4e6dcdb` 及运行 `44300999380`，原始日志确认采样和最终校验成功。 | 补回该运行、单样本结果及旧 LTO 条件；撤回“修正后从未实测”的说法。历史报告按写作日期保留限制，附后续更新。 |

P1 表示会改变依赖来源或日常反馈行为的缺口；P2 表示实验可信度和维护决策的缺口。
锁文件问题是复现出的构建入口缺陷，不代表已证明之前交付物的锁文件发生过漂移。
此前 `44549416311` 保存的构建后源码状态为空，没有显示这一问题曾在该次构建触发。

旧工作区插件 123,963,296 字节，SHA-256 为
`002fff2ffb5642500854659580ead51ae60c6784e1cea563560220601ae7fa92`；
新插件 93,884,000 字节，SHA-256 为
`2fbb3b6dc96cfb6ec0462f93fc91569973e1534180e14f73955cc06d95553386`。
备份及替换记录在 `workspace-native-backup/` 和 `workspace-native-installation.json`。
这些路径位于下述证据目录。用户安装的独立 CLI 未被替换。

## 规范与实际参数

工具链为 `rustc 1.102.0-nightly f5cedb83a`、Cargo `c07ac2c4d`，固定日期
`nightly-2026-11-08`；本机为 macOS Intel，Bun 1.4.4。当前项目只读执行：

```sh
cargo build --offline --locked -p pi-natives --profile dev \
  --target x86_64-apple-darwin --unit-graph -Z unstable-options
```

| 环境 / profile | pi-natives / pi-builtins 优化级别 | pi-shell 优化级别 | LTO | 三者 incremental |
| --- | --- | --- | --- | --- |
| 无 CI，dev | 0 | 1 | off | true |
| CI=true，dev | 0 | 1 | off | false |
| CI=true、CARGO_INCREMENTAL=1，dev | 0 | 1 | off | true |
| CI=true，local | 3 | 3 | thin | false |
| CI=true，ci | 3 | 3 | off | false |

Cargo 文档明确说明 `CI` 下的增量默认值、环境变量覆盖顺序，以及 `lto=false`
仍允许 crate 内 ThinLTO，`"off"` 才完全关闭。配置含有 `incremental=true`
不能替代实际编译计划；恢复 Actions 缓存也不能证明 Cargo 单元保持 Fresh。
[Cargo incremental](https://doc.rust-lang.org/cargo/reference/config.html#buildincremental)、
[Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html#lto)。

NAPI 官方文档支持通过 `--` 传 Cargo 参数，但已安装 CLI 的 metadata 调用在
转发 build 参数之前。前置检查因此有必要；单独给 build 加锁不足以覆盖前一步。
[Cargo metadata --locked](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html#manifest-options)、
[NAPI build](https://napi.rs/docs/cli/build#passing-flags-to-cargo)。

`embed-metadata=false` 的微型 lib/consumer 工程中，rlib 为 5648 / 3504 字节，
其中 `lib.rmeta` 成员为 2608 / 464 字节；两种构建的消费者均输出 42。
关闭嵌入后仍有元数据占位/链接信息，不能根据成员名仍存在就断言选项无效。
这验证了机制，不提供 Slim 整体体积或耗时收益。
[Cargo embed-metadata](https://doc.rust-lang.org/cargo/reference/unstable.html#embed-metadata)。

sccache 官方文档确认不能缓存 incremental crate 及调用系统链接器的
cdylib/bin/proc-macro；这个限制支持暂不把它作为最终 addon 加速方案，不能证明
本项目使用它一定更慢。[sccache Rust 支持](https://github.com/mozilla/sccache/blob/main/docs/Rust.md)。

## 哪些旧结论有证据，哪些仍不能推广

重新下载了 [43947005367](https://github.com/NexusKMT/omp-slim/actions/runs/43947005367)
的原始日志和状态，确认三个配置作业成功。native 单元预热后：

| 配置 | Cargo 自报编译秒数 | 包含 NAPI 构建/安装的墙钟秒数 |
| --- | ---: | ---: |
| O3 ThinLTO | 603 | 606 |
| O3 LTO off | 166 | 171 |
| O2 LTO off | 120 | 124 |

因此 O3 关闭 LTO 的方向有项目证据，但每种配置只有一次这类重编样本，且是旧源码、
无 rustc incremental、修改时间戳的实验。72.5% 对应 Cargo 编译部分，不能套到
冷启动、跨 job 缓存恢复、完整交付，或当前真实编辑循环上。

PTY 拆分也有直接依据：当前 native 的 unit graph 为 763 个单元、555 个不同包 ID；
独立 PTY test 图为 10 个单元、8 个不同包 ID，其中含 doctest 单元。它们不是同一种
数量口径。`pi-natives` 调用 `pi_pty::await_output_drain`，没有另存测试专用实现。
本轮 `CARGO_INCREMENTAL=1 bun run test:rs --package pi-pty` 的 7 项测试通过。
这证明定向测试边界有效，不意味着整个 addon 构建降到几秒。

旧的 dev/local 比较和 27 次前端矩阵记录仍有效，但当时 incremental 实际关闭，
dev 的 LTO 也与当前不同。它们用于定位旧配置的瓶颈，不能作为当前 dev 的验收。
不过，11 月 18 日的 [44300999380](https://github.com/NexusKMT/omp-slim/actions/runs/44300999380)
已经启用 incremental：一次 native 编辑构建/安装为 26.125s，Cargo 为 23.040s，
行为验证与 worker smoke 完成为 29.530s；稳定无修改构建 5.638s、0 单元。
源码恢复和 PTY、shell、grammar 校验均通过。其 `dev lto=false` 与当前 `"off"`
不同；这仍不是对当前配置的三次重复测量。
提高 jobs、关闭 WASM、checksum freshness 均缺少当前配置下可归因的完整反馈时间对照；
其中关闭 WASM 有依赖图和体积证据，不能据此补推编译提速。

## 本轮远程实测

运行 [44562078213](https://github.com/NexusKMT/omp-slim/actions/runs/44562078213)
使用未修改的审核基线，`compare_development=true`、`development_profile=dev`、
`benchmark_scope=full`。这是一个 runner 内的三个 native 函数体编辑，明确开启
incremental，逐次验证新 addon 的行为并运行 source worker smoke，再恢复源码。
本轮入口修正在该运行启动后进行，不能将该运行当成修正后脚本的远程验证。

运行成功，job 为 16:05:17–16:42:52 UTC。原始记录确认三个主要 crate 的
`incremental=true`、`lto=off`。三个编辑都只编译一个 `pi-natives` 单元：

| 编辑 | Cargo 秒数 | 构建/安装秒数 | 新行为验证与 worker smoke 完成秒数 |
| --- | ---: | ---: | ---: |
| tab 上限 16 → 17 | 18.400 | 23.053 | 26.907 |
| tab 上限 16 → 18 | 10.320 | 13.028 | 16.420 |
| tab 上限 16 → 19 | 16.340 | 19.665 | 23.421 |
| 中位数 | 16.340 | 19.665 | 23.421 |

本轮没有命中兼容缓存，预热构建/安装为 1880.567s（Cargo 1866.020s、763 单元）。
所谓 unchanged 为 18.470s（Cargo 15.390s、2 单元），属于 NAPI 初始化后的
额外稳定成本，不能拿它宣称无修改构建耗时。将该真实结果交给本轮新增的检查，
检查正确拒绝了它。随后三次编辑均只有一个源码编译单元，分别观察到新上限。

源码恢复哈希通过；原上限、worker smoke、导出、PTY/shell、grammar 和 shell
session 校验全部通过。三个样本来自同一 runner 的同一函数，仍不代表 shell、
builtins、公共 API 修改或跨 job 恢复，也不能将相对旧实验的差异全部归因于 LTO。

恢复后的 dev 插件为 195,280,920 字节，SHA-256：
`21cf4957e0f82a6a80d6b609b2309baceafdc6701291e20afa7994e0d4e5dd17`。
对照 ci 插件为 93,884,000 字节；开发符号、优化设置及保留产物均有实际成本。
本轮本机入口与计时修正的验证使用隔离小工程，没有在本机编译完整 native。

## 开发配置的运行成本

在同一本机 Intel Core m3-8100Y（2 核/4 线程、16 GiB RAM）、Bun 1.4.4 上
直接加载有已核对 SHA-256 的两个插件，
顺序为 ci/dev、dev/ci、ci/dev；每次启动新进程，预热后测三个批次，共每配置
每负载 9 个批次。固定输入和输出校验相同，排除把错误结果当作更快。
ci 来自 `44549416311`，dev 来自本轮 `44562078213`；两者 Rust 源码与锁文件
相同，profile 不同。整个 profile 同时改变优化、符号和检查选项，不归因于单一参数。

| 固定工作负载 | ci 中位数 ms/次 | dev 中位数 ms/次 | dev/ci |
| --- | ---: | ---: | ---: |
| ANSI/Unicode 文本宽度（256 次重复文本） | 0.0832 | 0.8945 | 10.76 |
| O200k token 计数（128 次重复段落） | 0.1214 | 2.2786 | 18.77 |
| 保留 Shell 实例，100 次算术循环 | 0.8382 | 1.1634 | 1.39 |

宽度、token 数、shell 输出分别稳定为 5632、2048、4950。每批次数分别为
200、20、5。完整输入、执行脚本和每批次数据保存于 `runtime-probe.mjs`、
`compare-runtime.py`、`runtime-comparison.json`；关键结果也进入审核数据 JSON。
小 shell 用例的绝对耗时很短、波动较大；这三项不是完整交互性能评测，更不能把
18.77 倍推广到整个 CLI。但足以否定“编译更快而运行几乎无代价”的假设。

当前处理：保留 ci 作为交付/本地使用的已验证插件；dev 用于显式的 Rust 修改验证。
没有因编辑耗时缩短就替换默认构建 profile。本轮 dev 插件只保存在证据目录。

## 证据与尚未覆盖的范围

本地证据目录：`dist/validation/build-audit-2026-11-20/`。包含原始 unit graph、
真实 OMP shell 环境探针、Cargo 小工程源码/执行脚本/日志、锁文件前后摘要、
修改后实际构建入口的验证，以及恢复的旧 Actions 日志。探针脚本不加入长期测试集。
关键测量从上述文件提取保存到 [审核数据](slim-build-audit-2026-11-20.json)，避免
Actions 七天 artifact 过期或本地 dist 清理后只剩手写结论。

新加锁定 preflight 的本机额外耗时为 1.467 / 1.033 / 1.022s（已缓存依赖，
offline metadata，三次调用）。这是为构建一致性支付的开销，不是加速改动。

`native-entry/summary.json` 的有效锁分支故意选择不存在的 profile 终止编译：它验证
锁检查、参数传递和锁文件不变，不能冒充完整 addon 构建通过。native 类型检查
27 个文件通过，全工作区 `bun run check:ts` 通过，脚本格式/lint 与 Python 语法检查通过。

本轮没有声称全项目或完整测试集健康：最近完整 TS gate 仍为 136/157 组通过。
只测了上述三个运行负载，没有证明 dev/ci 完整运行性能等价，也没有验证 Linux
当前构建性能。
已有编译实验脚本合计 562 行，macOS 工作流 608 行；这些是实际维护成本，不能
继续以增加矩阵规模替代对日常入口、缓存失效原因和关键行为的验证。
